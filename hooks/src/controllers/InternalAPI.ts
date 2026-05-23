import * as Express from "express";
import {
  Controller,
  Get,
  HeaderParams,
  PathParams,
  Res,
} from "ts-express-decorators";
import { logger } from "../logger";

const registryUrl = (process.env["REGISTRY_URL"] || "http://registry:5000").replace(/\/+$/, "");

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const REPO_SEGMENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function isValidRepository(repository: string): boolean {
  if (repository.length === 0 || repository.length > 256) {
    return false;
  }
  const segments = repository.split("/");
  return segments.every((segment) => REPO_SEGMENT_PATTERN.test(segment));
}

function authorized(authorization: string | undefined): boolean {
  const expected = process.env["INTERNAL_API_TOKEN"];
  if (!expected) {
    return false;
  }
  return authorization === `Token ${expected}`;
}

@Controller("/v1/internal")
export class InternalAPI {
  @Get("/blobs/:repository(*)/:digest")
  public async blobPresence(
    @Res() response: Express.Response,
    @HeaderParams("Authorization") authorization: string,
    @PathParams("repository") repository: string,
    @PathParams("digest") digest: string,
  ): Promise<any> {
    if (!authorized(authorization)) {
      response.status(401);
      return { error: "unauthorized" };
    }

    if (!DIGEST_PATTERN.test(digest)) {
      response.status(400);
      return { error: "invalid digest" };
    }

    if (!isValidRepository(repository)) {
      response.status(400);
      return { error: "invalid repository" };
    }

    const target = `${registryUrl}/v2/${repository}/blobs/${digest}`;

    let headResponse: Response;
    try {
      headResponse = await fetch(target, { method: "HEAD" });
    } catch (err) {
      logger.warn(`[internal] blob HEAD ${target} failed: ${(err as Error).message}`);
      response.status(502);
      return { error: "registry_unreachable" };
    }

    if (headResponse.status === 200) {
      const contentLengthHeader = headResponse.headers.get("content-length");
      const sizeBytes = contentLengthHeader == null ? null : Number(contentLengthHeader);
      response.status(200);
      return {
        present: true,
        digest,
        repository,
        sizeBytes: Number.isFinite(sizeBytes as number) ? sizeBytes : null,
      };
    }

    if (headResponse.status === 404) {
      response.status(200);
      return {
        present: false,
        digest,
        repository,
        sizeBytes: null,
      };
    }

    logger.warn(`[internal] blob HEAD ${target} returned status ${headResponse.status}`);
    response.status(502);
    return { error: "registry_status_" + headResponse.status };
  }
}
