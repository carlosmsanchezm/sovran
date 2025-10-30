{{/*
Expand the name of the chart.
*/}}
{{- define "aegis-services.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "aegis-services.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels
*/}}
{{- define "aegis-services.labels" -}}
app.kubernetes.io/name: {{ include "aegis-services.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{/*
Selector labels
*/}}
{{- define "aegis-services.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aegis-services.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Platform API component names */}}
{{- define "aegis-services.platformApi.fullname" -}}
{{- printf "%s-platform-api" (include "aegis-services.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-services.platformApi.secretName" -}}
{{- printf "%s-platform-api-secret" (include "aegis-services.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-services.platformApi.tlsSecretName" -}}
{{- printf "%s-platform-api-tls" (include "aegis-services.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Proxy component names */}}
{{- define "aegis-services.proxy.fullname" -}}
{{- printf "%s-proxy" (include "aegis-services.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-services.proxy.secretName" -}}
{{- printf "%s-proxy-secret" (include "aegis-services.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-services.proxy.tlsSecretName" -}}
{{- printf "%s-proxy-tls" (include "aegis-services.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-services.keycloak.namespace" -}}
{{- if .Values.keycloak.namespace -}}
{{- .Values.keycloak.namespace -}}
{{- else -}}
{{- .Release.Namespace -}}
{{- end -}}
{{- end -}}

{{- define "aegis-services.keycloak.fullname" -}}
{{- printf "%s-keycloak" (include "aegis-services.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-services.keycloak.serviceName" -}}
{{- include "aegis-services.keycloak.fullname" . -}}
{{- end -}}

{{- define "aegis-services.keycloak.labels" -}}
{{ include "aegis-services.labels" . }}
app.kubernetes.io/component: keycloak
{{- end -}}

{{- define "aegis-services.keycloak.selectorLabels" -}}
{{ include "aegis-services.selectorLabels" . }}
app.kubernetes.io/component: keycloak
{{- end -}}

{{- define "aegis-services.keycloak.postgresFullname" -}}
{{- printf "%s-db" (include "aegis-services.keycloak.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-services.keycloak.postgresServiceName" -}}
{{- include "aegis-services.keycloak.postgresFullname" . -}}
{{- end -}}

{{- define "aegis-services.keycloak.postgres.labels" -}}
{{ include "aegis-services.labels" . }}
app.kubernetes.io/component: keycloak-postgres
{{- end -}}

{{- define "aegis-services.keycloak.postgres.selectorLabels" -}}
{{ include "aegis-services.selectorLabels" . }}
app.kubernetes.io/component: keycloak-postgres
{{- end -}}

{{/* Component selector labels */}}
{{- define "aegis-services.platformApi.selectorLabels" -}}
{{ include "aegis-services.selectorLabels" . }}
app.kubernetes.io/component: platform-api
{{- end -}}

{{- define "aegis-services.proxy.selectorLabels" -}}
{{ include "aegis-services.selectorLabels" . }}
app.kubernetes.io/component: proxy
{{- end -}}
