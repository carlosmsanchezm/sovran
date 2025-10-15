bucket         = "aegis-platform-tf-state-bucket"
key            = "aegis/prod/terraform.tfstate"
region         = "us-east-1"
encrypt        = true
dynamodb_table = "aegis-terraform-locks"
