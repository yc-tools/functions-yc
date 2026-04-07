provider "yandex" {
  token              = var.iam_token
  cloud_id           = var.cloud_id
  folder_id          = var.folder_id
  zone               = var.zone
  storage_access_key = trimspace(var.storage_access_key) != "" ? var.storage_access_key : null
  storage_secret_key = trimspace(var.storage_secret_key) != "" ? var.storage_secret_key : null
}
