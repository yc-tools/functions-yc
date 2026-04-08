locals {
  manifest      = jsondecode(file(var.manifest_path))
  app_id        = "${var.app_name}-${var.env}"
  functions_map = { for fn in local.manifest.functions : fn.name => fn }
  deploy_bucket = trimspace(var.deploy_bucket_name) != "" ? var.deploy_bucket_name : "${local.app_id}-deploy"
  has_domain    = trimspace(var.domain_name) != ""
}

# ── Deploy bucket ─────────────────────────────────────────────────────────────

resource "yandex_storage_bucket" "deploy" {
  bucket = local.deploy_bucket
  acl    = "private"

  versioning {
    enabled = false
  }
}

# ── Service account ───────────────────────────────────────────────────────────

resource "yandex_iam_service_account" "sa" {
  name        = "${local.app_id}-sa"
  description = "Service account for ${var.app_name} functions"
  folder_id   = var.folder_id
}

resource "yandex_resourcemanager_folder_iam_member" "invoker" {
  folder_id = var.folder_id
  role      = "serverless.functions.invoker"
  member    = "serviceAccount:${yandex_iam_service_account.sa.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "storage_viewer" {
  folder_id = var.folder_id
  role      = "storage.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.sa.id}"
}

# ── Cloud Functions ───────────────────────────────────────────────────────────

resource "yandex_function" "fn" {
  for_each = local.functions_map

  name              = "${local.app_id}-${each.key}-fn"
  description       = "Function ${each.key} for ${var.app_name}"
  folder_id         = var.folder_id
  runtime           = var.nodejs_version
  entrypoint        = each.value.entry
  memory            = try(each.value.memory, var.function_memory)
  execution_timeout = tostring(try(each.value.timeout, var.function_timeout))

  user_hash = "${local.manifest.buildId}-${each.key}"

  package {
    bucket_name = yandex_storage_bucket.deploy.bucket
    object_name = "functions/${each.value.zipPath}"
  }

  service_account_id = yandex_iam_service_account.sa.id

  environment = try(each.value.env, { NODE_ENV = "production" })

  depends_on = [yandex_storage_bucket.deploy]
}

# ── API Gateway ───────────────────────────────────────────────────────────────

locals {
  # Build OpenAPI paths inline using actual function IDs
  openapi_paths = merge([
    for fn in local.manifest.functions : {
      (fn.route) = {
        "x-yc-apigateway-any-method" = {
          operationId = fn.name
          parameters = [
            for p in fn.params : {
              name     = p
              in       = "path"
              required = true
              schema   = { type = "string" }
            }
          ]
          "x-yc-apigateway-integration" = {
            type                   = "cloud_functions"
            function_id            = yandex_function.fn[fn.name].id
            service_account_id     = yandex_iam_service_account.sa.id
            payload_format_version = "1.0"
          }
        }
      }
    }
  ]...)

  openapi_spec = jsonencode({
    openapi = "3.0.0"
    info    = { title = var.app_name, version = "1.0.0" }
    paths   = local.openapi_paths
  })
}

resource "yandex_api_gateway" "main" {
  name        = "${local.app_id}-apigw"
  description = "API Gateway for ${var.app_name}"
  folder_id   = var.folder_id

  spec = local.openapi_spec

  dynamic "custom_domains" {
    for_each = local.has_domain ? [1] : []
    content {
      fqdn           = var.domain_name
      certificate_id = local.effective_cert_id
    }
  }

  depends_on = [yandex_function.fn]
}

# ── TLS Certificate ───────────────────────────────────────────────────────────

resource "yandex_cm_certificate" "main" {
  count     = local.has_domain && trimspace(var.certificate_id) == "" ? 1 : 0
  name      = "${local.app_id}-cert"
  folder_id = var.folder_id

  domains = [var.domain_name]

  managed {
    challenge_type = "DNS_CNAME"
  }
}

locals {
  effective_cert_id = trimspace(var.certificate_id) != "" ? var.certificate_id : (
    length(yandex_cm_certificate.main) > 0 ? yandex_cm_certificate.main[0].id : ""
  )
}

# ── DNS Zone ──────────────────────────────────────────────────────────────────

resource "yandex_dns_zone" "main" {
  count     = local.has_domain && var.create_dns_zone && trimspace(var.dns_zone_id) == "" ? 1 : 0
  name      = "${local.app_id}-zone"
  zone      = "${var.domain_name}."
  public    = true
  folder_id = var.folder_id
}

locals {
  effective_dns_zone_id = trimspace(var.dns_zone_id) != "" ? var.dns_zone_id : (
    length(yandex_dns_zone.main) > 0 ? yandex_dns_zone.main[0].id : ""
  )
}

resource "yandex_dns_recordset" "apigw_cname" {
  count   = local.has_domain && local.effective_dns_zone_id != "" ? 1 : 0
  zone_id = local.effective_dns_zone_id
  name    = "${var.domain_name}."
  type    = "CNAME"
  ttl     = 300
  data    = ["${yandex_api_gateway.main.domain}."]
}

resource "yandex_dns_recordset" "cert_validation" {
  count = (
    local.has_domain &&
    local.effective_dns_zone_id != "" &&
    length(yandex_cm_certificate.main) > 0 &&
    length(yandex_cm_certificate.main[0].challenges) > 0
  ) ? 1 : 0

  zone_id = local.effective_dns_zone_id
  name    = yandex_cm_certificate.main[0].challenges[0].dns_name
  type    = yandex_cm_certificate.main[0].challenges[0].dns_type
  ttl     = 60
  data    = [yandex_cm_certificate.main[0].challenges[0].dns_value]
}
