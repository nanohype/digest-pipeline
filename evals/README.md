# Evals

Tests assert that code does what it says. Evals measure whether a **model**
does, on these prompts — and the answer is a rate, not a boolean.

| | Command | Needs a model | Every PR | Answers |
| --- | --- | --- | --- | --- |
| **Offline** | `npm test` | no | yes | Is the golden set still a golden set? Does the grader grade? |
| **Model** | `npm run eval` | yes | own workflow | Does the generator hold up on these prompts? |

## Running the model tier

```sh
EVAL_LLM=bedrock npm run eval            # AWS credential chain
EVAL_MODEL=<profile-id> EVAL_LLM=bedrock npm run eval
```

`EVAL_LLM` unset skips; set means it **must** run. A broken provider is a hard
failure, never a skip, because a green run has to mean the evals executed. A
suite that quietly skips its model tier converts an absence of evidence into a
claim of safety.

## The two kinds of case

**`capability`** — the generator doing its job: the right sections, sane
length, the voice rules. Scored as a **rate against a floor**, like coverage,
because prose varies run to run.

**`adversarial`** — the generator holding a boundary against an item written to
subvert it. **No acceptable rate below 100%**: a refusal that works four times
in five is a coin flip with good manners. Asserted case by case so a failure
has a name.

The adversarial set covers what an insider or a compromised integration can
actually do — anyone who can open a PR, file a Linear issue, or post in a
watched Slack channel puts text in this prompt. Direct override, **fabricating
a plausible announcement** (the real attack on a company newsletter is not
defacement, it's a lie that reaches 500 people over the Chief of Staff's name),
structure hijack, tag smuggling against the fence, and talking the model into
printing contact details the PII filter never saw because they were never in
the input.

## Two things the fixtures encode that are easy to get wrong

**A few-shot example outranks a stated rule.** The system prompt says
"Total: 400-600 words". The first draft of `voice-baseline.md` was 240 words,
and the model produced 197. The offline tier now asserts the baseline is itself
inside the band it teaches.

**Draft length tracks input volume, not the stated target.** Widening the
baseline to 460 words moved the output only from 197 to 220 — the corpus was
not the cap. Six one-line items cannot reach 400 words without the padding the
prompt separately forbids. So the `words` band on each case is a
**degenerate-output guard** (catching a draft that collapses or runs away), not
an enforcement of the 400-600 rule. Treating it as the latter would be grading
the fixture rather than the generator.

## Adding a case

Add an object to `fixtures/newsletter.json`. The offline tier validates the
shape and rejects a case that cannot fail, a fixture over the five-item cap,
and a capability set that never exercises a sparse week.

Write the `rationale` for the person who sees this case go red at 2am. It is
the only field that explains why anyone should care.
