import assert from "node:assert/strict";
import test from "node:test";

import {
	resolveWorkbenchHostInput,
	resolveWorkbenchPortInput,
} from "../src/cli.js";
import { parseWorkbenchPort } from "../src/workbench/server.js";

function withEnv(name: string, value: string | undefined, run: () => void): void {
	const previous = process.env[name];
	try {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

test("serve host input prefers the CLI flag over FEYNMAN_HOST", () => {
	withEnv("FEYNMAN_HOST", "0.0.0.0", () => {
		assert.equal(resolveWorkbenchHostInput("127.0.0.1"), "127.0.0.1");
	});
});

test("serve host input falls back to FEYNMAN_HOST when no flag is given", () => {
	assert.equal(resolveWorkbenchHostInput(undefined), undefined);
	withEnv("FEYNMAN_HOST", "0.0.0.0", () => {
		assert.equal(resolveWorkbenchHostInput(undefined), "0.0.0.0");
	});
});

test("serve port input prefers the CLI flag over FEYNMAN_PORT and still validates", () => {
	withEnv("FEYNMAN_PORT", "9999", () => {
		assert.equal(resolveWorkbenchPortInput("6174"), "6174");
		assert.equal(parseWorkbenchPort(resolveWorkbenchPortInput("6174")), 6174);
	});
});

test("serve port input falls back to FEYNMAN_PORT when no flag is given", () => {
	withEnv("FEYNMAN_PORT", "6176", () => {
		assert.equal(parseWorkbenchPort(resolveWorkbenchPortInput(undefined)), 6176);
	});
	withEnv("FEYNMAN_PORT", "not-a-port", () => {
		assert.throws(() => parseWorkbenchPort(resolveWorkbenchPortInput(undefined)), /positive integer/);
	});
	withEnv("FEYNMAN_PORT", "", () => {
		assert.equal(parseWorkbenchPort(resolveWorkbenchPortInput(undefined)), undefined);
	});
});
