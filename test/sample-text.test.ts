// @ts-nocheck — imports a browser module.
import { expect, it } from "vitest";
import { SAMPLE_TEXT as client } from "../public/js/sample-text.js";
import { SAMPLE_TEXT as server } from "../src/voice";

it("the setup screen shows the same script the server uses as ref_text", () => {
  expect(client).toBe(server);
});
