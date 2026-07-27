#!/bin/bash
set -e

# Configuration
BACKUP_DIR="./backups"
MONGO_URI=${MONGO_URI:-"mongodb://localhost:27017/shortnews"}
DATE=$(date +%Y-%m-%d_%H-%M-%S)
RETENTION_DAYS=7
ARCHIVE_NAME="mongo_backup_$DATE.archive.gz"
BACKUP_PATH="$BACKUP_DIR/$ARCHIVE_NAME"

echo "Starting MongoDB Backup: $DATE"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Perform mongodump with gzip compression
echo "Dumping database..."
mongodump --uri="$MONGO_URI" --gzip --archive="$BACKUP_PATH"

# Calculate Checksum
echo "Calculating checksum..."
sha256sum "$BACKUP_PATH" > "$BACKUP_PATH.sha256"

# Verify restore (dry-run/list to ensure archive isn't corrupted)
echo "Verifying backup integrity..."
if mongorestore --gzip --archive="$BACKUP_PATH" --dryRun; then
    echo "Backup verified successfully."
else
    echo "Backup verification failed!"
    exit 1
fi

# Optional: Upload to S3 (Uncomment and configure to use)
# echo "Uploading to S3..."
# aws s3 cp "$BACKUP_PATH" s3://my-backup-bucket/mongodb/
# aws s3 cp "$BACKUP_PATH.sha256" s3://my-backup-bucket/mongodb/

# Enforce Retention Policy (Delete backups older than RETENTION_DAYS)
echo "Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -type f -name "*.archive.gz" -mtime +$RETENTION_DAYS -exec rm {} \;
find "$BACKUP_DIR" -type f -name "*.sha256" -mtime +$RETENTION_DAYS -exec rm {} \;

echo "Backup process completed successfully."
