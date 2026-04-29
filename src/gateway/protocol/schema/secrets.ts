import { Type, type Static } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const SecretsReloadParamsSchema = Type.Object({}, { additionalProperties: false });

export const SecretsResolveParamsSchema = Type.Object(
  {
    commandName: NonEmptyString,
    targetIds: Type.Array(NonEmptyString),
    /**
     * Optional agent id. When set the gateway resolves `keycard:*` refs
     * against a JWT carrying this `agent_id` claim; other sources ignore it
     * and read the gateway-shared configuration. Defaults to the agent id
     * parsed from the connection's session key (server-side).
     */
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export type SecretsResolveParams = Static<typeof SecretsResolveParamsSchema>;

export const SecretsResolveAssignmentSchema = Type.Object(
  {
    path: Type.Optional(NonEmptyString),
    pathSegments: Type.Array(NonEmptyString),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const SecretsResolveResultSchema = Type.Object(
  {
    ok: Type.Optional(Type.Boolean()),
    assignments: Type.Optional(Type.Array(SecretsResolveAssignmentSchema)),
    diagnostics: Type.Optional(Type.Array(NonEmptyString)),
    inactiveRefPaths: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export type SecretsResolveResult = Static<typeof SecretsResolveResultSchema>;
