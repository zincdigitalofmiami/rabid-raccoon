import test from "node:test";
import assert from "node:assert/strict";
import { canonicalSetupId } from "../src/lib/setup-id";
import type { WarbirdSetup } from "../src/lib/warbird-engine";
import {
  mapTriggeredWarbirdSetupToLegacyBhgWrite,
  recordTriggeredWarbirdSetups,
} from "../src/lib/warbird-setup-recorder";

function makeTriggeredWarbirdSetup(): WarbirdSetup {
  return {
    id: "warbird-bootstrap-1",
    direction: "BULLISH",
    phase: "TRIGGERED",
    fibLevel: 6950,
    fibRatio: 0.5,
    touchTime: 1710000000,
    hookTime: 1710000060,
    hookLow: 6948,
    hookHigh: 6956,
    hookClose: 6954,
    goTime: 1710000120,
    goType: "CLOSE",
    entry: 6954,
    stopLoss: 6942,
    tp1: 6974,
    tp2: 6992,
    createdAt: 1710000000,
    expiryBars: 20,
    legacyBridge: {
      delegated: true,
      sourceEngine: "bhg-engine",
      sourceId: "BULLISH-0.5-3",
    },
  };
}

test("warbird recorder mapping is explicit about physical legacy DB model", () => {
  const setup = makeTriggeredWarbirdSetup();
  const scoring = {
    pTp1: 0.61,
    pTp2: 0.34,
    correlationScore: 0.72,
    vixLevel: 18.55,
    modelVersion: "warbird-bootstrap-v0",
  };

  const mapped = mapTriggeredWarbirdSetupToLegacyBhgWrite(setup, scoring);

  assert.equal(mapped.mappingMeta.physicalTable, "bhg_setups");
  assert.equal(mapped.mappingMeta.physicalPhaseEnum, "BhgPhase");
  assert.equal(mapped.mappingMeta.mappedPhase, "GO_FIRED");
  assert.equal(mapped.mappingMeta.strategy, "warbird-input-mapped-to-legacy-bhg-model");
  assert.equal(mapped.create.phase, "GO_FIRED");
  assert.equal(mapped.create.timeframe, "M15");
  assert.equal(mapped.create.direction, "BULLISH");
  assert.equal(mapped.create.pTp1, 0.61);
  assert.equal(mapped.create.modelVersion, "warbird-bootstrap-v0");
});

test("warbird recorder mapping is stable for fixed inputs", () => {
  const setup = makeTriggeredWarbirdSetup();
  const scoring = {
    pTp1: 0.55,
    pTp2: 0.22,
    correlationScore: 0.41,
    vixLevel: 17.1,
    modelVersion: "warbird-bootstrap-v0",
  };

  const first = mapTriggeredWarbirdSetupToLegacyBhgWrite(setup, scoring);
  const second = mapTriggeredWarbirdSetupToLegacyBhgWrite(setup, scoring);

  assert.deepEqual(second, first);
  assert.equal(first.setupId, canonicalSetupId(setup));
});

test("recordTriggeredWarbirdSetups no-op path is runnable without DB", async () => {
  const persisted = await recordTriggeredWarbirdSetups([]);
  assert.equal(persisted, 0);
});
