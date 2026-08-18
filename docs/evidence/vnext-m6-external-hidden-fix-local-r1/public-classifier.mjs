const asRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;

const collectEnemyMotionSamples = (roots) => {
  const pending = [...roots];
  const seen = new Set();
  const samples = [];
  let visited = 0;
  while (pending.length > 0 && visited < 100000) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) {
      continue;
    }
    seen.add(value);
    visited += 1;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const record = asRecord(value);
    const payload = asRecord(record?.payload);
    const projection = asRecord(payload?.value);
    if (
      record?.kind === "state_sample" &&
      payload?.stateDomainId === "enemy.motion" &&
      payload?.semanticCoverage === "declared" &&
      Array.isArray(projection?.enemies)
    ) {
      for (const enemyValue of projection.enemies) {
        const enemy = asRecord(enemyValue);
        if (
          enemy !== null &&
          typeof enemy.name === "string" &&
          Number.isInteger(enemy.start_direction) &&
          Number.isInteger(enemy.direction) &&
          Number.isFinite(enemy.speed)
        ) {
          samples.push({
            name: enemy.name,
            startDirection: enemy.start_direction,
            direction: enemy.direction,
            speed: enemy.speed,
          });
        }
      }
    }
    pending.push(...Object.values(record));
  }
  return samples;
};

export const classifyM6PublicExecutionV1 = async (input) => {
  const samples = collectEnemyMotionSamples([
    input.gameToolExchanges,
    input.pinnedCaptures,
  ]);
  const contradictory = samples.filter(
    (sample) => sample.startDirection === 0 && sample.direction === 1,
  );
  return {
    publicSymptomObserved: contradictory.length > 0,
    observation: {
      schemaVersion: 1,
      classifierId: "moddable-platformer-enemy-direction-public-v1",
      stateDomainId: "enemy.motion",
      declaredSampleCount: samples.length,
      contradictorySampleCount: contradictory.length,
      contradictoryEnemies: contradictory.map((sample) => sample.name).sort(),
    },
  };
};
