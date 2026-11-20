# Plan the comparison before drawing the figure

## Establish what each mark represents

Record the source of the data, variable definitions, units and observation unit. Distinguish independent samples from repeated observations, technical repeats and clustered measurements. State which count is shown as `n`. Preserve missing values and report meaningful exclusions with their reasons and before/after counts. Do not treat repeated measurements as independent samples merely because they form separate rows.

Keep source files unchanged. Perform filtering, aggregation and unit conversion in a separate reproducible step. Retain enough information to match a displayed result to its input. If sources disagree, show the conflict or narrow the claim instead of silently choosing a convenient value.

## Select a form that answers the question

Use points and intervals for estimates with uncertainty, distribution plots for variation, lines for ordered change, and scatter plots for relationships between quantities. Use bars when comparison to a meaningful baseline is the intended task. Show individual observations when they are interpretable and do not disclose restricted data. A table can be clearer than a chart for a few exact values.

Keep related axes comparable. Explain changed limits, logarithmic scales, normalized values and broken axes. Do not connect unordered categories as though they form a continuous series. Avoid extra dimensions, decorative perspective and area encodings that distort the comparison. For a multi-panel figure, name each panel's role and remove panels that repeat the same evidence.

## Display uncertainty with its method

Label whether an interval shows a standard deviation, standard error, confidence interval, credible interval, prediction interval or observed range. Give the level and calculation method when relevant. Do not convert an interval into a different type for appearance. Show reported bounds as bounds, and preserve whether values are approximate.

Use inferential labels only when supported by the actual analysis. Define statistical symbols, specify the comparison, and retain relevant multiple-comparison adjustments. A narrow interval does not establish causation or remove sampling bias. An interval including zero does not prove that the effect is absent. A representative trace is not a group average.

## Keep source evidence and new graphics distinct

Reproduce a published panel only when permitted and useful. Preserve its scientific content, aspect ratio, legend and scale information. Identify the exact source and panel. Add explanation beside it rather than changing its data marks. If values are digitized from an image, identify them as estimates and describe the method and relevant limits.

Never synthesize microscopy, instrument traces or observations as evidence. A simulated or illustrative example is acceptable when explicitly requested or useful for explanation, provided its status is unmistakable and it is kept separate from measured results.

## Export and review at the intended size

Use the requested dimensions and current destination requirements. Prefer SVG or PDF for editable chart elements and a suitable raster preview when helpful. Preserve physical size during export; automatic tight cropping can change it. Check fonts and symbols after reopening the file. For raster panels, assess effective resolution at their placed size; upsampling cannot recover missing detail.

Inspect the final figure for readable labels, complete axes, clipping, unintended overlaps and correct panel order. Check that essential distinctions survive grayscale or color-vision changes when color carries meaning. Compare plotted quantities with the source table and examine captions separately for overstated conclusions. A rendering check verifies the file's appearance, not the validity of the underlying study.

For a named journal, check its current official artwork and disclosure requirements before claiming submission compliance. Do not impose one journal's dimensions, font sizes or resolution limits on every figure.
