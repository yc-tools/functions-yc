import path from 'path';
import fs from 'fs-extra';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { FunctionsManifest } from '../build/index.js';

export interface UploadOptions {
  outputDir: string;
  manifest: FunctionsManifest;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  endpoint?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

export class Uploader {
  async upload(options: UploadOptions): Promise<void> {
    const { outputDir, manifest, bucket, accessKey, secretKey, region, endpoint, dryRun, verbose } =
      options;

    const s3 = new S3Client({
      region: region ?? 'ru-central1',
      endpoint: endpoint ?? 'https://storage.yandexcloud.net',
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });

    for (const fn of manifest.functions) {
      const zipPath = path.join(outputDir, fn.zipPath);
      const key = `functions/${fn.zipPath}`;

      if (verbose) {
        console.log(`  Uploading ${fn.zipPath} → s3://${bucket}/${key}`);
      }

      if (!dryRun) {
        const fileStream = fs.createReadStream(zipPath);
        const upload = new Upload({
          client: s3,
          params: { Bucket: bucket, Key: key, Body: fileStream },
        });
        await upload.done();
      }
    }

    // Upload manifest
    const manifestPath = path.join(outputDir, 'functions.manifest.json');
    const manifestKey = 'functions.manifest.json';

    if (verbose) {
      console.log(`  Uploading manifest → s3://${bucket}/${manifestKey}`);
    }

    if (!dryRun) {
      const content = await fs.readFile(manifestPath);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: manifestKey,
          Body: content,
          ContentType: 'application/json',
        }),
      );
    }
  }
}
