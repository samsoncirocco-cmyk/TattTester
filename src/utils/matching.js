/**
 * Artist Matching Algorithm
 *
 * Scoring breakdown:
 * - Style Overlap: 40% (count of matching styles)
 * - Keyword Match: 25% (fuzzy match on tags)
 * - Distance: 15% (Haversine distance from user location)
 * - Budget Fit: 10% (artist hourly rate vs user budget)
 * - Random Quality: 10% (adds variety)
 */

// Simple zip code to coordinates map for Austin area
const ZIP_TO_COORDS = {
  '78701': { lat: 30.2711, lng: -97.7437 },
  '78702': { lat: 30.2625, lng: -97.7180 },
  '78703': { lat: 30.2847, lng: -97.7647 },
  '78704': { lat: 30.2485, lng: -97.7697 },
  '78705': { lat: 30.2922, lng: -97.7420 },
  '78721': { lat: 30.2757, lng: -97.7033 },
  '78722': { lat: 30.2851, lng: -97.7238 },
  '78723': { lat: 30.2931, lng: -97.7004 },
  '78724': { lat: 30.2793, lng: -97.6530 },
  '78725': { lat: 30.2193, lng: -97.6753 },
  '78726': { lat: 30.4038, lng: -97.8547 },
  '78727': { lat: 30.4268, lng: -97.7237 },
  '78728': { lat: 30.4479, lng: -97.6935 },
  '78729': { lat: 30.4453, lng: -97.7713 },
  '78730': { lat: 30.3482, lng: -97.8442 },
  '78731': { lat: 30.3321, lng: -97.7687 },
  '78732': { lat: 30.3769, lng: -97.8904 },
  '78733': { lat: 30.3258, lng: -97.8670 },
  '78734': { lat: 30.3686, lng: -97.9604 },
  '78735': { lat: 30.2628, lng: -97.8470 },
  '78736': { lat: 30.2242, lng: -97.8904 },
  '78737': { lat: 30.1825, lng: -97.9548 },
  '78738': { lat: 30.3125, lng: -97.9737 },
  '78739': { lat: 30.1936, lng: -97.8904 },
  '78741': { lat: 30.2374, lng: -97.7253 },
  '78742': { lat: 30.2193, lng: -97.6753 },
  '78744': { lat: 30.1970, lng: -97.7620 },
  '78745': { lat: 30.2140, lng: -97.8137 },
  '78746': { lat: 30.2797, lng: -97.7970 },
  '78747': { lat: 30.1547, lng: -97.8420 },
  '78748': { lat: 30.1713, lng: -97.7870 },
  '78749': { lat: 30.2186, lng: -97.8553 },
  '78750': { lat: 30.4479, lng: -97.7953 },
  '78751': { lat: 30.3121, lng: -97.7303 },
  '78752': { lat: 30.3247, lng: -97.7070 },
  '78753': { lat: 30.3643, lng: -97.6870 },
  '78754': { lat: 30.3436, lng: -97.6470 },
  '78756': { lat: 30.3147, lng: -97.7470 },
  '78757': { lat: 30.3443, lng: -97.7337 },
  '78758': { lat: 30.3736, lng: -97.7070 },
  '78759': { lat: 30.3943, lng: -97.7370 },
  // Default Austin coordinates
  'austin': { lat: 30.2672, lng: -97.7431 },
  'default': { lat: 30.2672, lng: -97.7431 }
};

/**
 * Get coordinates from zip code or city name
 * @param {string} location - Zip code or city name
 * @returns {Object} {lat, lng}
 */
export function getCoordinatesFromZipCode(location) {
  if (!location) return ZIP_TO_COORDS['default'];

  const clean = location.toLowerCase().trim();

  // Check if it's in our zip map
  if (ZIP_TO_COORDS[clean]) {
    return ZIP_TO_COORDS[clean];
  }

  // Check if it contains "austin"
  if (clean.includes('austin')) {
    return ZIP_TO_COORDS['austin'];
  }

  // Default to central Austin
  return ZIP_TO_COORDS['default'];
}

/**
 * Calculate Haversine distance between two points
 * @param {Object} coord1 - {lat, lng}
 * @param {Object} coord2 - {lat, lng}
 * @returns {number} Distance in miles
 */
function haversineDistance(coord1, coord2) {
  const R = 3959; // Earth's radius in miles
  const dLat = toRadians(coord2.lat - coord1.lat);
  const dLng = toRadians(coord2.lng - coord1.lng);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(coord1.lat)) * Math.cos(toRadians(coord2.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Calculate fuzzy keyword match score
 * @param {Array} userKeywords - Keywords from user preferences
 * @param {Array} artistTags - Tags from artist profile
 * @returns {number} Match score 0-1
 */
function calculateKeywordMatch(userKeywords, artistTags) {
  if (!userKeywords || !artistTags || userKeywords.length === 0 || artistTags.length === 0) {
    return 0;
  }

  let matches = 0;
  const normalizedUserKeywords = userKeywords.map(k => k.toLowerCase().trim());
  const normalizedArtistTags = artistTags.map(t => t.toLowerCase().trim());

  for (const keyword of normalizedUserKeywords) {
    for (const tag of normalizedArtistTags) {
      // Exact match
      if (keyword === tag) {
        matches += 1;
      }
      // Partial match (one contains the other)
      else if (keyword.includes(tag) || tag.includes(keyword)) {
        matches += 0.5;
      }
    }
  }

  // Normalize by total possible matches
  const maxMatches = Math.max(normalizedUserKeywords.length, normalizedArtistTags.length);
  return Math.min(matches / maxMatches, 1);
}

/**
 * Calculate budget fit score
 * @param {number} artistRate - Artist hourly rate
 * @param {number} userBudget - User's budget
 * @returns {number} Score 0-1
 */
function calculateBudgetFit(artistRate, userBudget) {
  if (!userBudget || !artistRate) return 0.5; // Neutral if no budget specified

  // If artist is within budget, score is 1
  if (artistRate <= userBudget) return 1;

  // If artist is over budget, score decreases based on how much over
  const overage = artistRate - userBudget;
  const overageRatio = overage / userBudget;

  // Exponential decay: 50% over = 0.5 score, 100% over = 0.25 score
  return Math.max(0, 1 / (1 + overageRatio));
}

/**
 * Calculate match score for a single artist
 * @param {Object} preferences - User preferences
 * @param {Object} artist - Artist data
 * @param {Object} userLocation - {lat, lng}
 * @returns {number} Total match score
 */
/**
 * Calculate match score for a single artist
 * @param {Object} preferences - User preferences
 * @param {Object} artist - Artist data
 * @param {Object} userLocation - {lat, lng}
 * @returns {Object} { score: number, reasons: Array }
 */
function calculateArtistScore(preferences, artist, userLocation) {
  const reasons = [];

  // 1. Style Overlap (40%)
  let styleScore = 0;
  if (preferences.styles && artist.styles) {
    const matchingStyles = preferences.styles.filter(style =>
      artist.styles.some(artistStyle =>
        artistStyle.toLowerCase() === style.toLowerCase()
      )
    );
    if (matchingStyles.length > 0) {
      styleScore = matchingStyles.length / Math.max(preferences.styles.length, 1);
      reasons.push(`Specializes in ${matchingStyles.join(', ')}`);
    }
  }

  // 2. Keyword Match (25%)
  const keywordScore = calculateKeywordMatch(
    preferences.keywords || [],
    artist.tags || []
  );
  if (keywordScore > 0.3) {
    reasons.push('High keyword match');
  }

  // 3. Distance (15%)
  let distanceScore = 0.5; // Default neutral score
  if (userLocation && artist.location) {
    // If we have precise coordinates for both
    if (artist.coordinates && userLocation.lat && userLocation.lng) {
      const distance = haversineDistance(userLocation, artist.coordinates);
      if (distance < 5) {
        distanceScore = 1.0;
        reasons.push('Likely nearby (< 5 miles)');
      } else if (distance < 10) {
        distanceScore = 0.75;
        reasons.push('Within 10 miles');
      } else if (distance < 20) {
        distanceScore = 0.5;
        reasons.push('Within 20 miles');
      } else {
        distanceScore = 0.25;
      }
    }
    // Fallback to city matching if coordinates fail or are generic
    else if (artist.city && preferences.location && artist.city.toLowerCase() === preferences.location.toLowerCase()) {
      distanceScore = 1.0;
      reasons.push(`Located in ${artist.city}`);
    }
  }

  // 4. Budget Fit (10%)
  const budgetScore = calculateBudgetFit(
    artist.hourlyRate || 150,
    preferences.budget || 200
  );
  if (budgetScore === 1) {
    reasons.push('Within your budget');
  }

  // 5. Random Quality (10%) - adds variety to results
  const randomScore = Math.random();

  // Weighted total
  const totalScore =
    (styleScore * 0.40) +
    (keywordScore * 0.25) +
    (distanceScore * 0.15) +
    (budgetScore * 0.10) +
    (randomScore * 0.10);

  return {
    score: totalScore,
    reasons: reasons.length > 0 ? reasons : ['Explore this artist']
  };
}

/**
 * Calculate and rank artist matches
 * @param {Object} preferences - User preferences from SmartMatch form
 * @param {Array} artists - Array of artist objects
 * @returns {Array} Sorted array of artists with match scores
 */
export function calculateMatches(preferences, artists) {
  if (!preferences || !artists || artists.length === 0) {
    return [];
  }

  // Get user location coordinates
  const userLocation = getCoordinatesFromZipCode(preferences.location);

  // Calculate scores for each artist
  // Calculate scores for each artist
  const scoredArtists = artists.map(artist => {
    const { score, reasons } = calculateArtistScore(preferences, artist, userLocation);
    return {
      ...artist,
      matchScore: score, // For sorting, using the raw 0-1 value
      score: score * 100, // For display, 0-100
      reasons: reasons
    };
  });

  // Sort by match score (highest first) and return top 20
  return scoredArtists
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 20);
}

// Swipe decisions used to live here, in localStorage under a hardcoded
// 'user-123' (trackSwipe / getLikedArtists / clearSwipeHistory). They are
// now stored per verified uid through /api/v1/match/decision — see
// src/app/swipe/decisionsClient.ts, which also removes the legacy key.
