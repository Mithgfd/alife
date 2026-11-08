<p align="center">
  <img src="banner.svg" alt="ALIFE — evolving foragers">
</p>

<p align="center">
  <sub>A small artificial-life world in p5.js. Creatures carry a genome, run a tiny neural net, eat, reproduce with mutation, and get eaten. Food is the only primary resource; everything else is evolution finding a way to convert it into copies of itself.</sub>
</p>

<br>

<table align="center">
  <tr>
    <td align="center"><strong>85 – 463</strong><br><sub>population</sub></td>
    <td align="center">&nbsp;&nbsp;&nbsp;</td>
    <td align="center"><strong>45 – 95</strong><br><sub>generations</sub></td>
    <td align="center">&nbsp;&nbsp;&nbsp;</td>
    <td align="center"><strong>0</strong><br><sub>extinctions</sub></td>
    <td align="center">&nbsp;&nbsp;&nbsp;</td>
    <td align="center"><strong>0</strong><br><sub>pinned at cap</sub></td>
  </tr>
</table>

<p align="center"><sub>Five seeded runs × 40k ticks on the shipped defaults.</sub></p>

---

## 01 — Quick start

```bash
open index.html        # macOS
xdg-open index.html    # Linux
```

No build step, no server, no install. `p5.min.js` is vendored, so it also works offline.

---

## 02 — The world

```text
alife/
  index.html   the page
  sketch.js    p5 rendering + controls
  sim.js       headless simulation core (no p5, no DOM)
  p5.min.js    vendored, so it works offline
  test.js      one-run metrics
  sweep.js     multi-seed parameter sweep
  validate.js  long-horizon check of the defaults
  smoke.js     headless browser smoke test (needs chromium)
```

---

## 03 — Controls

| Key | Action |
|:---:|:---|
| <kbd>space</kbd> | Pause / resume |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> | 1×, 4×, 16×, 64× simulation speed |
| <kbd>r</kbd> | Reset with a fresh random world |
| <kbd>p</kbd> | Toggle predation |
| <kbd>click</kbd> | Inspect a creature: energy, age, kills, genes |

Creature colour comes from its `hue` gene (neutral, so it drifts into lineages).
Brightness is current energy relative to its reproduction threshold — starving
creatures dim out.

---

## 04 — The model

### Genome

Six scalars plus 68 neural weights.

| Gene | Range | What it does |
|:---|:---:|:---|
| `size` | 0.55 – 2.10 | Body radius and mass (`mass = size²`) |
| `speedMax` | 0.20 – 2.20 | Top speed |
| `sense` | 12 – 110 px | Perception radius |
| `hue` | 0 – 1 | Colour only, neutral |
| `mutRate` | 0.02 – 0.60 | Mutation step size for its own offspring |
| `reproE` | 20 – 80 | Energy needed to reproduce (scaled by mass) |

`mutRate` is itself a gene, so evolvability is heritable.

### Brain

8 → 6 tanh → 2, fully connected.

Inputs are *egocentric* — forward/right relative to heading, not world x/y.

| # | Input | # | Input |
|:---:|:---|:---:|:---|
| 0 | Food forward | 4 | Creature right |
| 1 | Food right | 5 | Energy / threshold |
| 2 | Food proximity | 6 | Current speed / `speedMax` |
| 3 | Creature forward | 7 | Bias |

Outputs: `turn ∈ [−1, 1]`, `thrust ∈ [0, 1]`.

> Egocentric inputs matter. With world-frame `dx/dy` the network has no idea which
> way it is facing, so "steer toward food" is not a linear function it can learn.
> With forward/right it is one positive weight.

Generation 0 is not pure noise: each genome gets an innate, evolvable
phototaxis reflex (food-right → turn, food-ahead → thrust). Mutation can weaken,
invert, or rewire it like any other weight. Without it, random brains mostly
drift in circles and starve before reproducing, and the world never gets off the
ground.

### Energy

Per tick:

```text
cost = 0.05 + 0.04·mass + 0.12·mass^0.75·speed²
```

Food gives 28 energy. Reproduction costs `0.52 × threshold`; the child gets
`0.42 × threshold`; the rest is overhead. Threshold is
`30 + reproE · mass`. The fixed terms stop "be as small as possible" from being
strictly optimal.

### Predation

Any creature that touches one with less than `1/1.45` of its mass eats it,
gaining `0.5 × prey energy + 22 × prey mass`. Size is the trait, so there is no
gene "valley" to cross: being big pays immediately and being small is
immediately risky. This is what keeps the population from converging on one tiny
optimal forager.

### Food

Logistic regrowth toward a cap, mostly clustered around five slowly drifting
meadows. Patches create territories; uniform scatter does not.

### Seed bank

If the population falls below 20, competent random genomes trickle in. This is
the difference between "an interesting crash" and "a dead world you have to
restart".

---

## 05 — Knobs worth turning

All in `DEFAULTS` at the top of `sim.js`.

| Param | Effect |
|:---|:---|
| `foodGrowth` | Carrying capacity. This is the main population dial. |
| `foodCap` | How much food can exist at once. |
| `foodEnergy` | Calories per meal; changes how cheap reproduction is. |
| `maxPop` | Hard ceiling. If the population pins here, selection is neutral. |
| `predation` | Turn it off for a pure foraging world (everything shrinks). |
| `preySizeRatio` | How much bigger you must be to eat someone. |
| `basal`, `moveCost` | Metabolism; higher = faster turnover, sparser world. |
| `thresholdBase` | Fixed reproduction cost; keeps small bodies from being free. |
| `patchBias` | 0 = uniform food, 1 = fully clustered. |
| `immigrationBelow` | Extinction insurance. |

---

## 06 — Headless tools

The whole point of keeping `sim.js` free of p5 is that you can measure the
dynamics instead of squinting at the canvas.

```bash
node test.js 40000     # one run, prints population/extinction/oscillation
node sweep.js          # 6 configs × 3 seeds, prints a comparison table
node validate.js       # 5 seeds × 80k ticks on the shipped defaults
node smoke.js          # loads the page in headless chromium, checks for errors
```

`test.js`, `sweep.js`, and `validate.js` seed `Math.random`, so results are
reproducible. `smoke.js` needs `chromium` on `PATH`.

---

## 07 — What actually turned out to be hard

Five things, in the order they bit.

1. **A silent NaN.** The output-bias index was read from a cursor that had
   already advanced, so every creature's thrust was `NaN` and the world died on
   tick 0. No exception — just an empty canvas.

2. **Random brains don't forage.** The initial population has to be viable
   enough to found a lineage. Pure random weights are not. Hence the innate
   reflex.

3. **World-frame senses.** See above. This one is easy to miss because the
   simulation runs fine; it just never evolves anything interesting.

4. **The cap does the selecting.** If the population sits at `maxPop`, births are
   rejected at random, so fitness differences stop mattering and genes drift to
   their bounds. The fix is to make food the limiter and keep the cap as a safety
   valve. `validate.js` reports `pinned` for exactly this reason.

5. **Predation as a gene fails.** A `carn` gene that trades plant digestion for
   meat creates a fitness valley: you lose your old food source before you can
   use the new one, so carnivores never invade. Making size itself the predation
   trait removes the valley.

> **The one-line version:** food has to do the selecting, not the population cap.

The current defaults were chosen from a multi-seed sweep, not a single lucky
run. Five seeded runs of 40k ticks each: population 85–463 (mean 151–331),
45–95 generations, zero extinctions, and the population never pinned to the
ceiling. Different seeds settle on different strategies — one ends up small,
fast and predatory (304 kills), another big, slow and nearly peaceful (48
kills). That divergence is the interesting part, not a bug.

The system is chaotic, so any single run can spend a while in a trough. That is
what `validate.js` is for: judge the band across seeds, not the last frame.

---

## 08 — What's next

- **Seeded runs in the browser** (`?seed=`) so a good world is shareable.
- **Species tracking** by genome distance, with a stacked population graph.
- **Sexual reproduction** — crossover plus a compatibility radius would give real
  species splits instead of one drifting cloud.
- **Pheromones / trails**, which would make herding and territory behaviour
  possible with one more input.
- **Save/load a run** as JSON, since interesting worlds are rare and worth
  keeping.

<br>

<p align="center"><sub>p5.js · vanilla JavaScript · no build · works offline</sub></p>
