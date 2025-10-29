# Route53 Hosted Zone and DNS Records for Aegis Platform

# Create hosted zone for aegist domain
resource "aws_route53_zone" "aegist" {
  name = "aegist.dev"

  comment = "Aegis platform DNS zone for testing"

  tags = {
    Name        = "${local.cluster_name}-zone"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Get platform-api LoadBalancer from data source (created by Kubernetes)
# Note: This requires the LoadBalancer to exist before Terraform can reference it
# We'll use a local-exec provisioner workaround or rely on manual updates

# DNS record for platform-api gRPC endpoint
resource "aws_route53_record" "platform_api_grpc" {
  zone_id = aws_route53_zone.aegist.zone_id
  name    = "platform-api-grpc.aegist.dev"
  type    = "CNAME"
  ttl     = 300

  # This will be populated after the LoadBalancer is created
  # You'll need to run: terraform apply -var="platform_api_lb_hostname=<your-lb-hostname>"
  # Or use the script to auto-populate
  records = [var.platform_api_lb_hostname != "" ? var.platform_api_lb_hostname : "placeholder.elb.amazonaws.com"]
}

# DNS record for platform-api HTTP gateway
resource "aws_route53_record" "platform_api_http" {
  zone_id = aws_route53_zone.aegist.zone_id
  name    = "platform-api.aegist.dev"
  type    = "CNAME"
  ttl     = 300

  records = [var.platform_api_lb_hostname != "" ? var.platform_api_lb_hostname : "placeholder.elb.amazonaws.com"]
}

# DNS record for proxy
resource "aws_route53_record" "proxy" {
  zone_id = aws_route53_zone.aegist.zone_id
  name    = "proxy.aegist.dev"
  type    = "CNAME"
  ttl     = 300

  records = [var.proxy_lb_hostname != "" ? var.proxy_lb_hostname : "placeholder.elb.amazonaws.com"]
}

# DNS record for Keycloak
resource "aws_route53_record" "keycloak" {
  zone_id = aws_route53_zone.aegist.zone_id
  name    = "keycloak.aegist.dev"
  type    = "CNAME"
  ttl     = 300

  records = [var.keycloak_lb_hostname != "" ? var.keycloak_lb_hostname : "placeholder.elb.amazonaws.com"]
}

# Output nameservers for reference (in case you want to delegate from a parent domain)
output "route53_nameservers" {
  description = "Nameservers for the aegist.dev hosted zone"
  value       = aws_route53_zone.aegist.name_servers
}

output "platform_api_grpc_hostname" {
  description = "DNS hostname for platform-api gRPC endpoint"
  value       = aws_route53_record.platform_api_grpc.fqdn
}

output "platform_api_http_hostname" {
  description = "DNS hostname for platform-api HTTP gateway"
  value       = aws_route53_record.platform_api_http.fqdn
}

output "proxy_hostname" {
  description = "DNS hostname for proxy"
  value       = aws_route53_record.proxy.fqdn
}
