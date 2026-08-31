#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { Agent, OpenAIResponsesModel, Runner, tool } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall } from "@openai/agents/testing";
import { MemoryCoreClient } from "../../dist/client.js";
import { toOpenAIAgentsTools } from "../../dist/integrations/adapters/openai-agents.js";
import { createRemoteBackend } from "../../dist/integrations/tools.js";
import {
  attestInstalledPackageVersion,
  emit,
  exerciseFramework,
  fail,
  principalFor,
} from "./probe-lib.mjs";

class RecordingScriptedResponsesModel extends OpenAIResponsesModel {
  #scripted;
  providerInputs = [];

  constructor(steps) {
    // The fake client is never called: getResponse is overridden below. The
    // pinned Responses model still builds the exact provider input on every turn.
    super({ responses: {} }, "gpt-5.4");
    this.#scripted = new ScriptedModel(steps);
  }

  get calls() {
    return this.#scripted.calls;
  }

  assertComplete() {
    this.#scripted.assertComplete();
  }

  async getResponse(request) {
    const built = this._buildResponsesCreateRequest(request, false);
    this.providerInputs.push(structuredClone(built.requestData.input));
    return this.#scripted.getResponse(request);
  }
}

const framework = "openai-agents-adapter";
try {
  const versionAttestation = [await attestInstalledPackageVersion(
    "@openai/agents",
    "MC_EXPECTED_OPENAI_AGENTS_VERSION",
  )];
  const principal = principalFor("openai-agents");
  const marker = `agents-runner-${Date.now()}-${randomUUID()}`;
  const backend = createRemoteBackend(new MemoryCoreClient({
    baseUrl: process.env.MC_BASE_URL,
    apiKey: principal.key,
  }));
  const descriptors = toOpenAIAgentsTools({
    backend,
    identity: {
      tenantId: principal.tenantId,
      spaceId: principal.spaceId,
      appId: principal.appId,
      actorId: principal.actorId,
      threadId: "openai-scripted-runner",
    },
    sourceType: "openai-agents-scripted-runner",
  });
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const lifecycle = await exerciseFramework({
    framework,
    principalAppId: "openai-agents",
    version: `@openai/agents@${versionAttestation[0].actual}`,
    versionAttestation,
    toolNames: [...byName.keys()],
    call: async (name, args) => {
      const descriptor = byName.get(name);
      if (!descriptor) throw new Error(`native adapter did not expose ${name}`);
      return descriptor.execute(args);
    },
  });
  let runnerMemoryId;
  const tools = descriptors.map((descriptor) => tool({
    name: descriptor.name,
    description: descriptor.description,
    parameters: descriptor.parameters,
    strict: false,
    execute: async (args) => {
      const output = await descriptor.execute(args);
      if (descriptor.name === "remember") {
        runnerMemoryId = /id=(\S+)/.exec(String(output))?.[1] || runnerMemoryId;
      }
      return output;
    },
  }));
  const model = new RecordingScriptedResponsesModel([
    [functionCall("remember", {
      text: `OpenAI Agents runner retained ${marker}`,
      type: "tool_outcome",
      scope: "actor",
    }, { callId: "remember-call" })],
    [functionCall("recall", { query: marker, limit: 5 }, { callId: "recall-call" })],
    [assistantMessage("script complete")],
  ]);
  const agent = new Agent({
    name: "memory-core-compatibility",
    instructions: "Use the provided memory tools exactly as requested.",
    model,
    tools,
  });
  let result;
  let runnerError;
  let runnerCleanupCompleted = false;
  try {
    result = await new Runner({ tracingDisabled: true }).run(
      agent,
      `Remember and recall the marker ${marker}`,
      { maxTurns: 5 },
    );
    model.assertComplete();
    const providerInput = model.providerInputs.at(-1);
    if (!Array.isArray(providerInput)) {
      throw new Error("the Agents runner did not build a final Responses API input");
    }
    const recallOutputItem = providerInput.find((item) => (
      item?.type === "function_call_output" && item.call_id === "recall-call"
    ));
    if (!recallOutputItem) {
      throw new Error("the Agents runner did not produce a recall function_call_output item");
    }
    if (!(JSON.stringify(recallOutputItem.output) || "").includes(marker)) {
      throw new Error("the recall function_call_output did not contain the recalled marker");
    }
  } catch (error) {
    runnerError = error;
    throw error;
  } finally {
    try {
      if (!runnerMemoryId) {
        const recalled = String(await byName.get("recall").execute({ query: marker, limit: 5 }));
        runnerMemoryId = /id=(\S+)/.exec(recalled)?.[1];
      }
      if (!runnerMemoryId) {
        if (!runnerError) throw new Error("runner memory could not be identified for cleanup");
      } else {
        const forgotten = String(await byName.get("forget").execute({
          memoryId: runnerMemoryId,
          reason: "compatibility probe cleanup",
        }));
        if (/failed|error/i.test(forgotten)) throw new Error("runner memory cleanup failed");
        runnerCleanupCompleted = true;
      }
    } catch (cleanupError) {
      if (!runnerError) throw cleanupError;
    }
  }
  if (!runnerCleanupCompleted) throw new Error("runner memory cleanup was not completed");
  emit({
    ...lifecycle,
    finishedAt: new Date().toISOString(),
    tools: tools.map((item) => item.name).sort(),
    checks: [
      ...lifecycle.checks,
      "repo-adapter-load",
      "scripted-runner",
      "recall-function-call-output",
      "runner-cleanup",
    ],
    finalOutput: result.finalOutput,
  });
} catch (error) {
  fail(framework, error);
}
