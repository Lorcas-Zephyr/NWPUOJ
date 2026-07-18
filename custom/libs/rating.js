function winProbability(firstRating, secondRating) {
  return 1 / (1 + Math.pow(10, (secondRating - firstRating) / 400));
}

function contestantSeed(index, contestants) {
  let seed = 1;
  for (let other = 0; other < contestants.length; other++) {
    if (other !== index) seed += winProbability(contestants[other].currentRating, contestants[index].currentRating);
  }
  return seed;
}

function ratingSeed(rating, contestants) {
  return 1 + contestants.reduce((sum, contestant) => sum + winProbability(contestant.currentRating, rating), 0);
}

function ratingForAverageRank(index, contestants) {
  const averageRank = Math.sqrt(contestants[index].rank * contestantSeed(index, contestants));
  let left = 1;
  let right = 8000;
  while (right - left > 1) {
    const middle = (left + right) / 2;
    if (ratingSeed(middle, contestants) < averageRank) right = middle;
    else left = middle;
  }
  return left;
}

function calculateRatingChanges(contestants) {
  if (!Array.isArray(contestants) || contestants.length < 2) {
    throw new Error('At least two contestants are required.');
  }
  for (const contestant of contestants) {
    if (!Number.isFinite(contestant.currentRating) || !Number.isSafeInteger(contestant.rank) || contestant.rank < 1) {
      throw new Error('Invalid rating contestant.');
    }
  }
  let deltas = contestants.map((contestant, index) =>
    (ratingForAverageRank(index, contestants) - contestant.currentRating) / 2
  );
  const deltaSum = deltas.reduce((sum, delta) => sum + delta, 0);
  const firstAdjustment = -deltaSum / contestants.length - 1;
  deltas = deltas.map(delta => delta + firstAdjustment);

  const zeroSumCount = Math.min(Math.trunc(4 * Math.round(Math.sqrt(contestants.length))), contestants.length);
  const topSum = deltas.slice(0, zeroSumCount).reduce((sum, delta) => sum + delta, 0);
  const secondAdjustment = Math.min(Math.max(-topSum / zeroSumCount, -10), 0);

  return contestants.map((contestant, index) => {
    const ratingAfter = Math.max(1, Math.round(contestant.currentRating + deltas[index] + secondAdjustment));
    return Object.assign({}, contestant, {
      ratingAfter,
      delta: ratingAfter - contestant.currentRating
    });
  });
}

module.exports = { calculateRatingChanges, winProbability };
