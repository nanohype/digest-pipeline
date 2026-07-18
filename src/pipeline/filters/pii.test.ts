/**
 * Tests the app's PII wiring over the vendored @nanohype/runtime catalog.
 * The catalog itself (every pattern, positive + negative samples) is
 * unit-tested upstream in nanohype/library/runtime alongside the source
 * of truth — here we verify the union policy is live at this app's
 * boundaries and that the typed-token + run-id semantics hold.
 */

import { describe, expect, it } from "vitest";
import type { SourceItem } from "../types.js";
import { assertNoPii, piiFilter, piiScan, sanitizeSourceItem } from "./pii.js";

describe("piiFilter", () => {
  it("redacts with typed tokens, not a generic marker", () => {
    expect(piiFilter("Ping sarah.doe+digest-pipeline@example.com later")).toBe(
      "Ping [EMAIL] later",
    );
    expect(piiFilter("Offer of $150,000 base salary")).toContain("[COMPENSATION]");
  });

  it("still blocks the original app categories (comp, HR, health, contact, ids)", () => {
    expect(piiFilter("salary of £80,000 confirmed")).toContain("[COMPENSATION]");
    expect(piiFilter("Offer is 120k annually")).toContain("[COMPENSATION]");
    expect(piiFilter("Placed on PIP last quarter")).toContain("[HR]");
    expect(piiFilter("Tracking HR-2034 through resolution")).toContain("[HR_CASE]");
    expect(piiFilter("Approved FMLA leave extension")).toContain("[HEALTH]");
    expect(piiFilter("She is on medical leave this month")).toContain("[HEALTH]");
    expect(piiFilter("Call (415) 555-1234 if needed")).toContain("[PHONE]");
    expect(piiFilter("Reach the London office on +44 20 7946 0958")).not.toContain("7946");
    expect(piiFilter("Mail to 1600 Pennsylvania Ave today")).toContain("[ADDRESS]");
    expect(piiFilter("SSN 123-45-6789 appeared in the log")).not.toContain("123-45-6789");
    expect(piiFilter("Card 4242 4242 4242 4242 seen in diff")).not.toMatch(/4242 4242 4242 4242/);
    expect(piiFilter("DOB: 04/11/1986 from the spreadsheet")).toContain("[DOB]");
  });

  it("redacts the union categories this app previously lacked (secrets, aws, customer/infra)", () => {
    expect(piiFilter("rotate key AKIAIOSFODNN7EXAMPLE now")).toBe("rotate key [AWS_KEY] now");
    expect(piiFilter("leaked ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      "leaked [GITHUB_PAT]",
    );
    expect(piiFilter("bot token xoxb-123456789012-abcdefGHIJKL revoked")).toBe(
      "bot token [SLACK_TOKEN] revoked",
    );
    expect(piiFilter("deployed to 123456789012 aws")).toBe("deployed to [AWS_ACCOUNT] aws");
    expect(piiFilter("affects cust-99231 only")).toBe("affects [CUSTOMER_ID] only");
    expect(piiFilter("pod at 10.0.12.5 crashed")).toBe("pod at [INTERNAL_IP] crashed");
    expect(piiFilter("failing over db-orders-primary")).toBe("failing over [INTERNAL_HOST]");
  });

  it("does not redact benign uses of common health/comp words", () => {
    expect(piiFilter("The team is in good health and morale is high.")).toBe(
      "The team is in good health and morale is high.",
    );
    expect(piiFilter("Base your decision on the data.")).toBe("Base your decision on the data.");
    expect(piiFilter("We are taking the lead on this project.")).toBe(
      "We are taking the lead on this project.",
    );
  });

  it("leaves clean text untouched", () => {
    const clean = "We shipped the new dashboard on Tuesday.";
    expect(piiFilter(clean)).toBe(clean);
  });
});

describe("piiScan", () => {
  it("returns structured findings (category + label) for every matched pattern", () => {
    const findings = piiScan("Email sarah@example.com and SSN 123-45-6789");
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings).toContainEqual({
      category: "contact",
      label: "email",
      matches: ["sarah@example.com"],
    });
    expect(findings).toContainEqual({
      category: "financial",
      label: "ssn",
      matches: ["123-45-6789"],
    });
  });

  it("returns empty array on clean input", () => {
    expect(piiScan("Nothing to see here")).toEqual([]);
  });
});

describe("assertNoPii", () => {
  it("throws when PII is present, including the run id in the message", () => {
    expect(() => assertNoPii("Email: john@example.com", "run-123")).toThrow(/run-123/);
  });

  it("throws on the widened categories too (a leaked secret blocks the checkpoint)", () => {
    expect(() => assertNoPii("token xoxb-123456789012-abcdefGHIJKL", "run-456")).toThrow(
      /secrets\/slack_token/,
    );
  });

  it("does not throw on clean text", () => {
    expect(() => assertNoPii("The quarterly newsletter is ready.", "run-xyz")).not.toThrow();
  });
});

describe("sanitizeSourceItem", () => {
  it("filters title and description so items leave the aggregator redacted", () => {
    const item: SourceItem = {
      id: "src-1",
      source: "github",
      section: "what_shipped",
      title: "Rotated AKIAIOSFODNN7EXAMPLE after the incident",
      description: "Contact sarah@example.com; pod 10.0.12.5 recovered.",
      publishedAt: new Date("2026-04-10T00:00:00Z"),
      rawSignals: {},
    };
    const sanitized = sanitizeSourceItem(item);
    expect(sanitized.title).toBe("Rotated [AWS_KEY] after the incident");
    expect(sanitized.description).toBe("Contact [EMAIL]; pod [INTERNAL_IP] recovered.");
    expect(() =>
      assertNoPii(`${sanitized.title}\n${sanitized.description}`, "run-sanitize"),
    ).not.toThrow();
  });
});
