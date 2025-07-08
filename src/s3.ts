import type { ApiConfig } from "./config";

export async function uploadVideoToS3(
    cfg: ApiConfig,
    key: string,
    processFilePath: string,
    contentType: string
) {
    console.log(`aws key is ${key}`)
    const s3File = cfg.s3Client.file(key, { bucket: cfg.s3Bucket })
    const videoFile = Bun.file(processFilePath)
    await s3File.write(videoFile, { type: contentType })
}