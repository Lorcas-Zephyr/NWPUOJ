const DEFAULT_CONFIG = Object.freeze({
  initialRating: 1500,
  initialDeviation: 350,
  initialVolatility: 0.06,
  tau: 0.5,
  scale: 173.7178,
  convergence: 0.000001,
  minimumDeviation: 30,
  maximumDeviation: 350
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedConfig(input = {}) {
  return {
    initialRating: finite(input.initialRating ?? input.rating, DEFAULT_CONFIG.initialRating),
    initialDeviation: finite(input.initialDeviation ?? input.deviation, DEFAULT_CONFIG.initialDeviation),
    initialVolatility: finite(input.initialVolatility ?? input.volatility, DEFAULT_CONFIG.initialVolatility),
    tau: finite(input.tau, DEFAULT_CONFIG.tau),
    scale: finite(input.scale, DEFAULT_CONFIG.scale),
    convergence: finite(input.convergence, DEFAULT_CONFIG.convergence),
    minimumDeviation: finite(input.minimumDeviation ?? input.minimum_deviation, DEFAULT_CONFIG.minimumDeviation),
    maximumDeviation: finite(input.maximumDeviation ?? input.maximum_deviation, DEFAULT_CONFIG.maximumDeviation)
  };
}

function g(deviation) {
  return 1 / Math.sqrt(1 + 3 * deviation * deviation / (Math.PI * Math.PI));
}

function expectedScore(rating, opponentRating, opponentDeviation) {
  return 1 / (1 + Math.exp(-g(opponentDeviation) * (rating - opponentRating)));
}

function updatedVolatility(phi, sigma, variance, improvement, config) {
  const alpha = Math.log(sigma * sigma);
  const tauSquared = config.tau * config.tau;
  const objective = value => {
    const exponential = Math.exp(value);
    const numerator = exponential * (improvement * improvement - phi * phi - variance - exponential);
    const denominator = 2 * Math.pow(phi * phi + variance + exponential, 2);
    return numerator / denominator - (value - alpha) / tauSquared;
  };

  let lower = alpha;
  let upper;
  if (improvement * improvement > phi * phi + variance) {
    upper = Math.log(improvement * improvement - phi * phi - variance);
  } else {
    let step = 1;
    while (objective(alpha - step * config.tau) < 0) step += 1;
    upper = alpha - step * config.tau;
  }

  let lowerValue = objective(lower);
  let upperValue = objective(upper);
  while (Math.abs(upper - lower) > config.convergence) {
    const candidate = lower + (lower - upper) * lowerValue / (upperValue - lowerValue);
    const candidateValue = objective(candidate);
    if (candidateValue * upperValue <= 0) {
      lower = upper;
      lowerValue = upperValue;
    } else {
      lowerValue /= 2;
    }
    upper = candidate;
    upperValue = candidateValue;
  }
  return Math.exp(lower / 2);
}

function updatePlayer(player, opponents, inputConfig) {
  const config = normalizedConfig(inputConfig);
  const rating = finite(player.rating, config.initialRating);
  const deviation = finite(player.deviation, config.initialDeviation);
  const volatility = finite(player.volatility, config.initialVolatility);
  const mu = (rating - config.initialRating) / config.scale;
  const phi = deviation / config.scale;

  if (!opponents.length) {
    const nextDeviation = Math.min(config.maximumDeviation, config.scale * Math.sqrt(phi * phi + volatility * volatility));
    return { rating, deviation: nextDeviation, volatility };
  }

  let varianceDenominator = 0;
  let scoreSum = 0;
  for (const opponent of opponents) {
    const opponentMu = (finite(opponent.rating, config.initialRating) - config.initialRating) / config.scale;
    const opponentPhi = finite(opponent.deviation, config.initialDeviation) / config.scale;
    const weight = g(opponentPhi);
    const expectation = expectedScore(mu, opponentMu, opponentPhi);
    varianceDenominator += weight * weight * expectation * (1 - expectation);
    scoreSum += weight * (finite(opponent.score, 0.5) - expectation);
  }

  const variance = 1 / varianceDenominator;
  const improvement = variance * scoreSum;
  const nextVolatility = updatedVolatility(phi, volatility, variance, improvement, config);
  const preRatingDeviation = Math.sqrt(phi * phi + nextVolatility * nextVolatility);
  const nextPhi = 1 / Math.sqrt(1 / (preRatingDeviation * preRatingDeviation) + 1 / variance);
  const nextMu = mu + nextPhi * nextPhi * scoreSum;
  return {
    rating: config.initialRating + config.scale * nextMu,
    deviation: Math.min(config.maximumDeviation, Math.max(config.minimumDeviation, config.scale * nextPhi)),
    volatility: nextVolatility
  };
}

function calculatePeriod(players, inputConfig = {}) {
  if (!Array.isArray(players) || players.length < 2) throw new Error('At least two players are required.');
  const config = normalizedConfig(inputConfig);
  for (const player of players) {
    if (!Number.isSafeInteger(Number(player.userId)) || !Number.isSafeInteger(Number(player.rank)) || Number(player.rank) < 1) {
      throw new Error('Invalid Glicko-2 player.');
    }
  }

  return players.map(player => {
    const opponents = players.filter(opponent => opponent !== player).map(opponent => ({
      rating: opponent.rating,
      deviation: opponent.deviation,
      score: Number(player.rank) < Number(opponent.rank) ? 1 : Number(player.rank) === Number(opponent.rank) ? 0.5 : 0
    }));
    const next = updatePlayer(player, opponents, config);
    const ratingBefore = finite(player.rating, config.initialRating);
    const ratingAfter = Math.max(1, Math.round(next.rating));
    return {
      ...player,
      ratingBefore,
      deviationBefore: finite(player.deviation, config.initialDeviation),
      volatilityBefore: finite(player.volatility, config.initialVolatility),
      ratingAfter,
      deviationAfter: Number(next.deviation.toFixed(6)),
      volatilityAfter: Number(next.volatility.toFixed(9)),
      delta: ratingAfter - Math.round(ratingBefore)
    };
  });
}

module.exports = {
  DEFAULT_CONFIG,
  calculatePeriod,
  expectedScore,
  normalizedConfig,
  updatePlayer
};
