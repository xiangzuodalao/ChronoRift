import type {
  InspectionObjectV1,
  InspectionStopOutputV1,
  InspectionWatchArchiveV1,
  InspectionWatchReadOutputV1,
} from "@chronorift/domain";

const optionalMetadata = (target: InspectionObjectV1) =>
  Object.fromEntries(
    Object.entries(target).filter(
      ([key]) => key !== "objectRef" && key !== "className",
    ),
  );

const targetLegend =
  "# target=[metadata,...cells]; metadata=null uses bound target, otherwise replaces ALL optional target fields; objectRef/className stay bound. Cells follow names: [value]=success, [status,message]=error; JSON value tags are unchanged.";

function formatRows(
  records: InspectionWatchArchiveV1["records"],
  boundTargets: InspectionWatchArchiveV1["state"]["boundTargets"],
): string[] {
  const boundMetadata = boundTargets.map(({ target }) =>
    JSON.stringify(optionalMetadata(target)),
  );
  return records.map((record) =>
    JSON.stringify([
      record.sequence,
      record.sample.processFrame,
      record.sample.physicsTick,
      ...record.targets.map(({ target, values }, index) => {
        // The strict watch schema fixes objectRef/className, but allows optional
        // target metadata to change or disappear between observations.
        const metadata = optionalMetadata(target);
        return [
          JSON.stringify(metadata) === boundMetadata[index] ? null : metadata,
          ...values.map((property) =>
            property.status === "success"
              ? [property.value]
              : [property.status, property.message],
          ),
        ];
      }),
    ]),
  );
}

/** Presentation only, after strict response validation; never changes the page. */
export function formatInspectionWatchReadText(
  page: InspectionWatchReadOutputV1,
): string {
  const { records, ...header } = page;
  return [
    "game_watch read",
    JSON.stringify({ schemaVersion: 1, outcome: "success", output: header }),
    `# records=${records.length}; row=[sequence,processFrame,physicsTick,...targets]; targets follow boundTargets order.`,
    targetLegend,
    "# bytesUsed/requiredByteBudget count canonical record bytes, not this text. deliveryComplete describes delivery, not page exhaustion or sampling completion.",
    ...formatRows(records, page.boundTargets),
  ].join("\n");
}

/** Preserve the complete stop response; only move archive records into rows. */
export function formatInspectionStopText(
  output: InspectionStopOutputV1,
): string {
  const { watch, ...record } = output.record;
  if (watch === undefined)
    return JSON.stringify(
      { schemaVersion: 1, outcome: "success", output },
      null,
      2,
    );
  const { records, ...archiveHeader } = watch;
  return [
    "game_stop",
    JSON.stringify({
      schemaVersion: 1,
      outcome: "success",
      output: { ...output, record: { ...record, watch: archiveHeader } },
    }),
    `# records=${records.length}; restore rows to output.record.watch.records; row=[sequence,processFrame,physicsTick,...targets]; targets follow output.record.watch.state.boundTargets order.`,
    targetLegend,
    "# deliveryComplete describes archive delivery; records may be fewer than recordedCount or have sequence gaps. All acquired records are shown; missing records are not fabricated.",
    ...formatRows(records, watch.state.boundTargets),
  ].join("\n");
}
