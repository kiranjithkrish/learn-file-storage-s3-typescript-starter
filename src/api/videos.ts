import { respondWithJSON } from "./json";
import path from "path";
import { type ApiConfig } from "../config";
import { file, S3Client, type BunRequest, type S3File } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "crypto";
import { uploadVideoToS3 } from "../s3";
import { json } from "stream/consumers";
import { JsonWebTokenError } from "jsonwebtoken";
import { write } from "console";

const MAX_UPLOAD_SIZE = 1 << 30;

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const params = req.params as { videoId?: string };
  const videoID = params.videoId;
  if (!videoID) {
    throw new BadRequestError("Invalid video id");
  }
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!uuidRegex.test(videoID)) {
    throw new BadRequestError("Check your videoID");
  }
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  const videoMetadata = await getVideo(cfg.db, videoID);
  if (!videoMetadata) {
    throw new NotFoundError("Couldn't find video");
  }
  if (videoMetadata?.userID !== userID) {
    throw new UserForbiddenError("Not authorised");
  }
  const formData = await req.formData();
  const videoFile = formData.get("video");

  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Video file is missing");
  }
  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Check your video size");
  }
  if (videoFile.type !== "video/mp4") {
    throw new BadRequestError("Please upload a mp4 format video file");
  }
  const tempPath = path.join("/tmp", `${videoID}.mp4`);
  await Bun.write(tempPath, videoFile);
  const aspectRatio = await getVideoAspectRatio(tempPath);
  const key = `${aspectRatio}/${videoID}.mp4`;
  // Create an S3File reference
  try {
    await uploadVideoToS3(cfg, key, tempPath, videoFile.type);
    const videoUrl = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
    console.log(`Video url: ${videoUrl}`);
    videoMetadata.videoURL = videoUrl;
    updateVideo(cfg.db, videoMetadata);
    return respondWithJSON(200, videoMetadata);
  } catch (err) {
    console.log("aws upload failed");
  }
}

export async function getVideoAspectRatio(filePath: string): Promise<string> {
  const proc = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ]);

  // Wait for process to complete
  const exitCode = await proc.exited;
  const output = await new Response(proc.stdout).text();
  const error = await new Response(proc.stderr).text();

  // Check for errors
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed: ${error}`);
  }

  // Validate output
  if (!output.trim()) {
    throw new Error("Empty output from ffprobe");
  }

  // Parse JSON safely
  let info;
  try {
    info = JSON.parse(output);
  } catch (e: unknown) {
    if (e instanceof Error) {
      throw new Error(`Failed to parse ffprobe output: ${e.message}`);
    } else {
      throw new Error("Failed to parse ffprobe output: Unknown error");
    }
  }

  // Ensure video stream exists
  const videoStream = info.streams?.[0];
  if (!videoStream) {
    throw new Error("No video stream found in file");
  }

  // Parse dimensions
  const width = Number(videoStream.width);
  const height = Number(videoStream.height);

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("Invalid width or height in video stream");
  }

  return getAspectRatio(width, height);
}

function getAspectRatio(width: number, height: number): string {
  const epsilon = 0.01;
  const ratio = width / height;
  const aspectRatios = {
    landscape: 16 / 9,
    portrait: 9 / 16,
  };
  for (const [name, target] of Object.entries(aspectRatios)) {
    if (Math.abs(ratio - target) < epsilon) {
      return name;
    }
  }
  return "other";
}

export type Stream = {
  width: string;
  height: string;
  codec_type: string;
};
