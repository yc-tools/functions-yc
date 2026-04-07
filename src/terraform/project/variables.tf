variable "cloud_id" {
  description = "Yandex Cloud ID"
  type        = string
}

variable "folder_id" {
  description = "Yandex Cloud folder ID"
  type        = string
}

variable "iam_token" {
  description = "Yandex Cloud IAM token"
  type        = string
  sensitive   = true
}

variable "app_name" {
  description = "Application name (lowercase alphanumeric + hyphens, 3-31 chars)"
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,29}[a-z0-9]$", var.app_name))
    error_message = "app_name must be 3-31 lowercase alphanumeric characters or hyphens."
  }
}

variable "env" {
  description = "Deployment environment (dev, staging, production)"
  type        = string
  default     = "production"

  validation {
    condition     = contains(["dev", "staging", "production"], var.env)
    error_message = "env must be one of: dev, staging, production."
  }
}

variable "region" {
  description = "Yandex Cloud region"
  type        = string
  default     = "ru-central1"
}

variable "zone" {
  description = "Yandex Cloud availability zone"
  type        = string
  default     = "ru-central1-a"
}

variable "nodejs_version" {
  description = "Node.js runtime version for Cloud Functions"
  type        = string
  default     = "nodejs20"

  validation {
    condition     = contains(["nodejs18", "nodejs20", "nodejs22"], var.nodejs_version)
    error_message = "nodejs_version must be one of: nodejs18, nodejs20, nodejs22."
  }
}

variable "function_memory" {
  description = "Memory (MB) for Cloud Functions"
  type        = number
  default     = 256
}

variable "function_timeout" {
  description = "Execution timeout (seconds) for Cloud Functions"
  type        = number
  default     = 30
}

variable "storage_access_key" {
  description = "Yandex Object Storage access key"
  type        = string
  default     = ""
  sensitive   = true
}

variable "storage_secret_key" {
  description = "Yandex Object Storage secret key"
  type        = string
  default     = ""
  sensitive   = true
}

variable "deploy_bucket_name" {
  description = "Bucket for storing function artifacts (created if empty)"
  type        = string
  default     = ""
}

variable "manifest_path" {
  description = "Path to the functions.manifest.json file"
  type        = string
}

variable "domain_name" {
  description = "Custom domain for the API Gateway"
  type        = string
  default     = ""
}

variable "dns_zone_id" {
  description = "Existing DNS zone ID (created if empty and domain_name is set)"
  type        = string
  default     = ""
}

variable "certificate_id" {
  description = "Existing TLS certificate ID (created if empty and domain_name is set)"
  type        = string
  default     = ""
}

variable "create_dns_zone" {
  description = "Create a new DNS zone for domain_name"
  type        = bool
  default     = false
}
