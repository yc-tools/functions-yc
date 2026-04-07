output "api_gateway_domain" {
  description = "Default API Gateway domain"
  value       = yandex_api_gateway.main.domain
}

output "api_gateway_id" {
  description = "API Gateway ID"
  value       = yandex_api_gateway.main.id
}

output "api_gateway_url" {
  description = "API Gateway URL"
  value       = "https://${yandex_api_gateway.main.domain}"
}

output "custom_domain" {
  description = "Custom domain (if configured)"
  value       = local.has_domain ? var.domain_name : null
}

output "deploy_bucket" {
  description = "Object Storage bucket for function artifacts"
  value       = yandex_storage_bucket.deploy.bucket
}

output "service_account_id" {
  description = "Service account ID for functions"
  value       = yandex_iam_service_account.sa.id
}
