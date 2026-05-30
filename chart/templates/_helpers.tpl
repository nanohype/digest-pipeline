{{- define "dispatch.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "dispatch.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Common labels — applied to every resource in this chart */}}
{{- define "dispatch.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "dispatch.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
agents.nanohype.dev/tenant: protohype
agents.nanohype.dev/platform: dispatch
{{- end -}}

{{/* Per-service selector — adds dispatch.io/service: <name> to distinguish
     pipeline / api / web workloads under the same chart release */}}
{{- define "dispatch.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dispatch.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
dispatch.io/service: {{ .service }}
{{- end -}}

{{- define "dispatch.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "dispatch.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Standard env block — applied identically to pipeline, api, web.
     Per-service overrides happen by appending to the rendered env list. */}}
{{- define "dispatch.env" -}}
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
- name: VOICE_BASELINE_BUCKET
  value: {{ .Values.tenantInfra.voiceBaselineBucket | quote }}
- name: RAW_AGGREGATIONS_BUCKET
  value: {{ .Values.tenantInfra.rawAggregationsBucket | quote }}
- name: SLACK_REVIEW_CHANNEL_ID
  value: {{ .Values.tenantInfra.slackReviewChannelId | quote }}
- name: APPROVERS_SECRET_ID
  value: {{ .Values.tenantInfra.approversSecretId | quote }}
- name: WORKOS_DIRECTORY_SECRET_ID
  value: {{ .Values.tenantInfra.workosDirectorySecretId | quote }}
{{- end -}}
