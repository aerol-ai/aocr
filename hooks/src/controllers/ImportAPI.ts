import * as Express from "express";
import {
  BodyParams,
  Controller,
  HeaderParams,
  Post,
  Res,
} from "ts-express-decorators";

import { logger } from "../logger";
import {
  Manifest,
  collectBlobDigests,
  mountAllBlobs,
  writeManifest,
} from "../util/mountFromRepo";

// F21. Copy a manifest the mirror has already cached under
// `mirror/<host>/<repo>` into a cluster-owned namespace
// `cluster/<cluster_id>/_imported/<host>/<repo>:<tag><suffix>`. No bytes move
// — every blob is mounted from the mirror repo using Distribution v2's
// mount-from-repo API. The point is to give a cluster a stable, retention-
// suffixed handle to an upstream image so the reaper treats it the same way
// it treats any other tagged image with that suffix.

const registryUrl = (process.env["REGISTRY_URL"] || "http://registry:5000").replace(/\/+$/, "");

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const HOST_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?$/i;
const REPO_SEGMENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const CLUSTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SUFFIX_PATTERN = /^--[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_TAG_SUFFIX = "--idle-90d";

const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const DOCKER_LIST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.list.v2+json";

type ImportBody = {
  upstream_host?: unknown;
  upstream_repo?: unknown;
  upstream_tag?: unknown;
  upstream_digest?: unknown;
  cluster_id?: unknown;
  target_tag_suffix?: unknown;
};

type Validated = {
  upstreamHost: string;
  upstreamRepo: string;
  upstreamTag: string;
  upstreamDigest: string;
  clusterId: string;
  tagSuffix: string;
};

function authorized(authorization: string | undefined): boolean {
  const expected = process.env["INTERNAL_API_TOKEN"];
  if (!expected || !authorization) return false;
  // Accept both `Bearer <token>` (preferred, what sandbox-library sends) and
  // the legacy `Token <token>` form so any pre-existing internal caller keeps
  // working. Constant-time compare prevents timing-leaking the expected value.
  const space = authorization.indexOf(" ");
  if (space <= 0) return false;
  const scheme = authorization.slice(0, space);
  const presented = authorization.slice(space + 1);
  if (scheme !== "Bearer" && scheme !== "Token") return false;
  return constantTimeEquals(presented, expected);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isValidRepoPath(repo: string): boolean {
  if (repo.length === 0 || repo.length > 256) return false;
  return repo.split("/").every((seg) => REPO_SEGMENT_PATTERN.test(seg));
}

function validate(body: ImportBody): { ok: true; value: Validated } | { ok: false; error: string } {
  if (typeof body.upstream_host !== "string" || !HOST_PATTERN.test(body.upstream_host)) {
    return { ok: false, error: "invalid upstream_host" };
  }
  if (typeof body.upstream_repo !== "string" || !isValidRepoPath(body.upstream_repo)) {
    return { ok: false, error: "invalid upstream_repo" };
  }
  if (typeof body.upstream_tag !== "string" || !TAG_PATTERN.test(body.upstream_tag)) {
    return { ok: false, error: "invalid upstream_tag" };
  }
  if (typeof body.upstream_digest !== "string" || !DIGEST_PATTERN.test(body.upstream_digest)) {
    return { ok: false, error: "invalid upstream_digest" };
  }
  if (typeof body.cluster_id !== "string" || !CLUSTER_ID_PATTERN.test(body.cluster_id)) {
    return { ok: false, error: "invalid cluster_id" };
  }
  let tagSuffix = DEFAULT_TAG_SUFFIX;
  if (body.target_tag_suffix !== undefined && body.target_tag_suffix !== null) {
    if (typeof body.target_tag_suffix !== "string" || !SUFFIX_PATTERN.test(body.target_tag_suffix)) {
      return { ok: false, error: "invalid target_tag_suffix" };
    }
    tagSuffix = body.target_tag_suffix;
  }
  return {
    ok: true,
    value: {
      upstreamHost: body.upstream_host.toLowerCase(),
      upstreamRepo: body.upstream_repo,
      upstreamTag: body.upstream_tag,
      upstreamDigest: body.upstream_digest.toLowerCase(),
      clusterId: body.cluster_id,
      tagSuffix,
    },
  };
}

@Controller("/v1/internal")
export class ImportAPI {
  @Post("/imports")
  public async importImage(
    @Res() response: Express.Response,
    @HeaderParams("Authorization") authorization: string,
    @BodyParams() body: ImportBody,
  ): Promise<any> {
    if (!authorized(authorization)) {
      response.status(401);
      return { error: "unauthorized" };
    }

    const validation = validate(body || {});
    if (!validation.ok) {
      response.status(400);
      return { error: validation.error };
    }
    const v = validation.value;

    const srcRepo = `mirror/${v.upstreamHost}/${v.upstreamRepo}`;
    const dstRepo = `cluster/${v.clusterId}/_imported/${v.upstreamHost}/${v.upstreamRepo}`;
    const dstTag = `${v.upstreamTag}${v.tagSuffix}`;
    const targetRef = `${dstRepo}:${dstTag}`;

    // Idempotency: if the destination tag already resolves to this digest,
    // there is nothing to do. The mount-from-repo path is itself idempotent,
    // but checking here avoids a manifest fetch + N blob mount requests on
    // re-runs (which the retry reconciler on the sandboxd side will do).
    const existingDigest = await headManifestDigest(dstRepo, dstTag);
    if (existingDigest && existingDigest.toLowerCase() === v.upstreamDigest) {
      response.status(200);
      return {
        imported: false,
        already_present: true,
        target_repository: dstRepo,
        target_tag: dstTag,
        target_ref: targetRef,
        digest: v.upstreamDigest,
      };
    }

    // Fetch the manifest from the mirror side. We address by digest so the
    // body is content-pinned — no chance of racing a mirror cache update.
    const manifestUrl = `${registryUrl}/v2/${srcRepo}/manifests/${v.upstreamDigest}`;
    let manifestResp: Response;
    try {
      manifestResp = await fetch(manifestUrl, {
        method: "GET",
        headers: {
          accept: [
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.oci.image.manifest.v1+json",
            OCI_INDEX_MEDIA_TYPE,
            DOCKER_LIST_MEDIA_TYPE,
          ].join(","),
        },
      });
    } catch (err) {
      logger.warn(`[import] manifest GET ${manifestUrl} failed: ${(err as Error).message}`);
      response.status(502);
      return { error: "registry_unreachable" };
    }

    if (manifestResp.status === 404) {
      response.status(404);
      return { error: "source_manifest_not_found" };
    }
    if (manifestResp.status !== 200) {
      logger.warn(`[import] manifest GET ${manifestUrl} returned ${manifestResp.status}`);
      response.status(502);
      return { error: `registry_status_${manifestResp.status}` };
    }

    const mediaType = manifestResp.headers.get("content-type") || "application/vnd.docker.distribution.manifest.v2+json";
    if (mediaType.includes("manifest.list") || mediaType.includes("image.index")) {
      // Multi-arch index. Mounting needs recursive treatment of each child
      // manifest's layers + a re-PUT of each child by digest. Out of scope
      // for PR 4e MVP; AerolVM sandboxes are single-platform today.
      response.status(501);
      return { error: "multi_arch_not_implemented" };
    }

    const manifestBody = await manifestResp.text();
    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestBody);
    } catch (err) {
      logger.warn(`[import] manifest body unparseable: ${(err as Error).message}`);
      response.status(502);
      return { error: "registry_returned_invalid_manifest" };
    }

    const digests = collectBlobDigests(manifest);
    if (digests.length === 0) {
      response.status(502);
      return { error: "manifest_references_no_blobs" };
    }

    const mountResult = await mountAllBlobs(manifest, srcRepo, dstRepo, {
      registryUrl,
    });
    if (!mountResult.allMounted) {
      // Surface the precise outcome so the sandboxd retry reconciler can
      // distinguish "source blob missing" (mirror cache hasn't pulled it yet
      // — retry later) from a hard registry error.
      logger.warn(`[import] mount failed for ${targetRef}: ${JSON.stringify(mountResult.outcomes)}`);
      response.status(502);
      return { error: "mount_failed", outcomes: mountResult.outcomes };
    }

    const write = await writeManifest(dstRepo, dstTag, manifestBody, mediaType, { registryUrl });
    if (write.status !== 201) {
      logger.warn(`[import] manifest PUT ${targetRef} returned ${write.status}: ${write.body}`);
      response.status(502);
      return { error: `manifest_put_failed_${write.status}`, detail: write.body };
    }

    response.status(201);
    return {
      imported: true,
      already_present: false,
      target_repository: dstRepo,
      target_tag: dstTag,
      target_ref: targetRef,
      digest: write.digest || v.upstreamDigest,
    };
  }
}

async function headManifestDigest(repo: string, tag: string): Promise<string | null> {
  const url = `${registryUrl}/v2/${repo}/manifests/${encodeURIComponent(tag)}`;
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      headers: {
        accept: [
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.oci.image.manifest.v1+json",
          OCI_INDEX_MEDIA_TYPE,
          DOCKER_LIST_MEDIA_TYPE,
        ].join(","),
      },
    });
    if (resp.status !== 200) return null;
    return resp.headers.get("docker-content-digest");
  } catch {
    return null;
  }
}
