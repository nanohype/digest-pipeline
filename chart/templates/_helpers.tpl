{{/*
App-specific helpers. Name/fullname/labels/serviceAccountName come from the
shared tenant-chart-base library (charts/tenant-chart-base); only the
multi-service selector and the shared env block live here.
*/}}

{{/* Per-service selector — adds digest-pipeline.io/service: <name> to distinguish
     pipeline / api / web workloads under the same chart release */}}
{{- define "digest-pipeline.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tenant-chart-base.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
digest-pipeline.io/service: {{ .service }}
{{- end -}}

{{/* Standard env block — applied identically to pipeline, api, web.
     Per-service overrides happen by appending to the rendered env list. */}}
{{- define "digest-pipeline.env" -}}
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
- name: VOICE_BASELINE_BUCKET
  value: {{ .Values.tenantInfra.voiceBaselineBucket | quote }}
- name: RAW_AGGREGATIONS_BUCKET
  value: {{ .Values.tenantInfra.rawAggregationsBucket | quote }}
- name: APPROVERS_SECRET_ID
  value: {{ .Values.tenantInfra.approversSecretId | quote }}
- name: WORKOS_DIRECTORY_SECRET_ID
  value: {{ .Values.tenantInfra.workosDirectorySecretId | quote }}
- name: SLACK_SECRET_ID
  value: {{ .Values.tenantInfra.slackSecretId | quote }}
- name: GITHUB_SECRET_ID
  value: {{ .Values.tenantInfra.githubSecretId | quote }}
- name: LINEAR_SECRET_ID
  value: {{ .Values.tenantInfra.linearSecretId | quote }}
- name: NOTION_SECRET_ID
  value: {{ .Values.tenantInfra.notionSecretId | quote }}
{{- end -}}
