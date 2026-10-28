import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  projectConfigSchema,
  newProjectConfig,
} from "../src/shared/project-config";

mkdirSync("examples", { recursive: true });
writeFileSync(
  "examples/project.schema.json",
  JSON.stringify(
    z.toJSONSchema(projectConfigSchema, { target: "draft-7", io: "input" }),
    null,
    2,
  ) + "\n",
  "utf8",
);

// Use the same complete starter as the application's Save template command.
writeFileSync(
  "examples/project-template.json",
  newProjectConfig() + "\n",
  "utf8",
);
