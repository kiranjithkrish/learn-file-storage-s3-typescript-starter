import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};
const MAX_UPLOAD_SIZE = 10 << 20; //10mb in bytes
const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  const mimeType = req.headers.get('content-type')
  if (mimeType !== "image/jpeg" && mimeType !== "image/png" ) {
    throw new BadRequestError('Unsupported file')
  }
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = req.formData()
  const imageData = (await formData).get('thumbnail')
  if (!(imageData instanceof File)) {
      throw new BadRequestError('Image data is invalid')
  }
  if (imageData.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError('Check your file size')
  }
  const mediaType = imageData.type
  const arrayBuffer = await imageData.arrayBuffer()
  const imageExtension = getExtensionFromMime(mediaType)
  const assetPath = path.join(cfg.assetsRoot, `${videoId}.${imageExtension}`)
  await Bun.write(assetPath, arrayBuffer);

  const videoMetadata = await getVideo(cfg.db, videoId)
  if(videoMetadata?.userID !== userID) {
    throw new UserForbiddenError('Access denied')
  }
  const url = new URL(req.url)
  const baseUrl = `${url.protocol}/${url.host}`
  const thumbnailUrl = path.join(baseUrl, assetPath)
  videoMetadata.thumbnailURL = thumbnailUrl
  await updateVideo(cfg.db, videoMetadata)
  return respondWithJSON(200, videoMetadata);
}

function getExtensionFromMime(mime: string) {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    // Add more as needed
  };
  return map[mime] || 'bin'; // fallback to .bin for unknown types
}