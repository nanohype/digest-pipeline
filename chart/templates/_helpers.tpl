{{/*
App-specific helpers. Name/fullname/labels/serviceAccountName come from the
shared tenant-chart-base library (charts/tenant-chart-base); only the
multi-service selector, the per-service image reference and the shared env
block live here.
*/}}

{{/* The tag a service runs: its own image.tag, else the chart's appVersion.
     release.yml builds every image from one `v<version>` git tag and tags each
     `<version>`. Once the run for `v<appVersion>` succeeds for every workload,
     appVersion names one release of all of them. Its matrix legs run
     independently, so a failed leg leaves that workload's image unpublished at
     the version the others pushed.
     Called with (dict "service" "<name>" "image" .Values.<name>.image "Chart" .Chart). */}}
{{- define "digest-pipeline.imageTag" -}}
{{- $tag := toString (.image.tag | default .Chart.AppVersion) -}}
{{- required (printf "%s.image.tag is empty and Chart.yaml sets no appVersion to default it to" .service) $tag -}}
{{- end -}}

{{/* The full image reference for a service. Same arguments as digest-pipeline.imageTag. */}}
{{- define "digest-pipeline.image" -}}
{{- $repository := required (printf "%s.image.repository is required" .service) .image.repository -}}
{{- printf "%s:%s" $repository (include "digest-pipeline.imageTag" .) -}}
{{- end -}}

{{/* Per-service selector — adds digest-pipeline.io/service: <name> to distinguish
     pipeline / api / web workloads under the same chart release */}}
{{- define "digest-pipeline.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tenant-chart-base.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
digest-pipeline.io/service: {{ .service }}
{{- end -}}

{{/* Standard env block — applied identically to pipeline, api, web and the
     migrate hook. Per-service overrides happen by appending to the rendered
     env list. Same arguments as digest-pipeline.imageTag plus "Values": the
     image is what OTEL_RESOURCE_ATTRIBUTES reports as service.version, so the
     version on every span and metric is the version of the image that emitted
     it, including a service pinned to a tag other than appVersion. */}}
{{- define "digest-pipeline.env" -}}
{{- $version := include "digest-pipeline.imageTag" . -}}
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
{{- if eq $k "OTEL_RESOURCE_ATTRIBUTES" }}
{{- if regexMatch "(^|,)[[:space:]]*service\\.version[[:space:]]*=" (toString $v) }}
{{- fail "env.OTEL_RESOURCE_ATTRIBUTES sets service.version; remove it — the chart appends each container's image tag as service.version" }}
{{- end }}
  value: {{ compact (list (toString $v) (printf "service.version=%s" $version)) | join "," | quote }}
{{- else }}
  value: {{ $v | quote }}
{{- end }}
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
