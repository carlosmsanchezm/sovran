{{- define "aegis-spoke.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-spoke.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "aegis-spoke.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-spoke.labels" -}}
app.kubernetes.io/name: {{ include "aegis-spoke.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "aegis-spoke.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aegis-spoke.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- /* Component-specific names */ -}}
{{- define "aegis-spoke.k8sAgent.fullname" -}}
{{- printf "%s-k8s-agent" (include "aegis-spoke.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-spoke.proxy.fullname" -}}
{{- printf "%s-proxy" (include "aegis-spoke.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-spoke.proxy.secretName" -}}
{{- printf "%s-proxy-secret" (include "aegis-spoke.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aegis-spoke.proxy.tlsSecretName" -}}
{{- printf "%s-proxy-tls" (include "aegis-spoke.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
