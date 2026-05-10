{{/*
Expand the name of the chart.
*/}}
{{- define "lobu.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "lobu.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by labels.
*/}}
{{- define "lobu.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "lobu.labels" -}}
helm.sh/chart: {{ include "lobu.chart" . }}
{{ include "lobu.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "lobu.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lobu.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "lobu.appSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: api
{{- end }}

{{- define "lobu.workerSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: worker
{{- end }}

{{- define "lobu.embeddingsSelectorLabels" -}}
{{ include "lobu.selectorLabels" . }}
app.kubernetes.io/component: embeddings
{{- end }}

{{/*
Resolve the image tag.
*/}}
{{- define "lobu.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag }}
{{- end }}

{{- define "lobu.appImage" -}}
{{- printf "%s/%s-app:%s" .Values.image.registry .Values.image.repository (include "lobu.imageTag" .) }}
{{- end }}

{{- define "lobu.workerImage" -}}
{{- printf "%s/%s-worker:%s" .Values.image.registry .Values.image.repository (include "lobu.imageTag" .) }}
{{- end }}

{{- define "lobu.embeddingsImage" -}}
{{- printf "%s/%s-embeddings:%s" .Values.image.registry .Values.image.repository (include "lobu.imageTag" .) }}
{{- end }}

{{/*
The Secret loaded into pods via envFrom, if configured.
*/}}
{{- define "lobu.secretName" -}}
{{- if .Values.secrets.create }}
{{- default (printf "%s-secrets" (include "lobu.fullname" .)) .Values.secrets.name }}
{{- else }}
{{- .Values.secretName }}
{{- end }}
{{- end }}
