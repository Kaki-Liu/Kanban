import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { itemSchema, importSchema, projectSchema, logSchema, noteSchema, settingsSchema } from "../src/shared/contracts";
import { workflowSchema } from "../src/shared/workflow";
import { projectConfigSchema, newProjectConfig } from "../src/shared/project-config";
import { widgetPreferencesSchema } from "../src/shared/widget";

mkdirSync("src-tauri/schemas", { recursive: true });
const schemas = { item: itemSchema, import: importSchema, project: projectSchema, log: logSchema, note: noteSchema, settings: settingsSchema, workflow: workflowSchema, projectConfig: projectConfigSchema, widget: widgetPreferencesSchema };
writeFileSync("src-tauri/schemas/contracts.json", JSON.stringify(Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: "draft-7", io: "input" })])), null, 2) + "\n", "utf8");
writeFileSync("src-tauri/schemas/project-template.json", newProjectConfig() + "\n", "utf8");
