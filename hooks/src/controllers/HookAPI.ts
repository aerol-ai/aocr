import * as Express from "express";
import {
  Controller,
  Post,
  Res,
  HeaderParams,
  BodyParams,
  Req} from "ts-express-decorators";
import { createPool } from "../util/database";
import {
  bindMetricsPool,
  recordWebhookAuthorization,
} from "../metrics";
import {
  DELETE_MANIFEST_SQL,
  isManifestPullMediaType,
  processRegistryEvents,
  UPDATE_LAST_PULLED_AT_SQL,
} from "./hookEvents";

export {
  DELETE_MANIFEST_SQL,
  isManifestPullMediaType,
  UPDATE_LAST_PULLED_AT_SQL,
};

interface ErrorResponse {
  error: any;
}

const pool = createPool();
bindMetricsPool(pool);

@Controller("/v1/hook")
export class HookAPI {
  @Post("/registry-event")
  public async hook(
    @Res() response: Express.Response,
    @Req() request: Express.Request,
    @HeaderParams("Authorization") authorization: string,
    @BodyParams("") body: any,
  ): Promise<ErrorResponse | {}> {
    if (authorization !== `Token ${process.env["HOOK_TOKEN"]}`) {
      recordWebhookAuthorization("rejected");
      response.status(401);
      return {};
    }

    recordWebhookAuthorization("accepted");
    await processRegistryEvents(body, { pgPool: pool });

    return {};
  }
}
