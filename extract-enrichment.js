#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Config
const BATCH_FILE = '/Users/samson/tatt-scraper/data/enrichment/batches/batch-001.json';
const SHARD_FILE = '/Users/samson/tatt-scraper/data/enrichment/shards/shard-001.json';
const USER_AGENT = 'TatTBot/1.0 (+github.com/samsoncirocco-cmyk/TatT)';
const FETCH_TIMEOUT = 15000;
const SLEEP_MS = 1000;

// Canonical style mappings
const CANONICAL_STYLES = {
  'traditional': 'Traditional',
  'neo-traditional': 'Neo-Traditional',
  'black and grey': 'Black & Grey',
  'black & grey': 'Black & Grey',
  'black-and-grey': 'Black & Grey',
  'blackwork': 'Blackwork',
  'black work': 'Blackwork',
  'fine line': 'Fine Line',
  'fine-line': 'Fine Line',
  'realism': 'Realism',
  'realistic': 'Realism',
  'illustrative': 'Illustrative',
  'illustration': 'Illustrative',
  'japanese': 'Japanese',
  'watercolor': 'Watercolor',
  'geometric': 'Geometric',
  'tribal': 'Tribal',
  'chicano': 'Chicano',
  'anime': 'Anime',
  'minimalist': 'Minimalist',
  'minimalism': 'Minimalist',
  'script': 'Script',
};

// Load batch
const batch = JSON.parse(fs.readFileSync(BATCH_FILE, 'utf8'));

// Storage for results
const results = {
  batch: 1,
  artists: {},
};

// Tracking
const stats = {
  domainsDone: 0,
  domainsFailed: [],
  artistsEnriched: 0,
  newStyles: 0,
  newImages: 0,
  samples: [],
};

// Fetch utility with timeout and robot.txt respect
async function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: FETCH_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Check robots.txt compliance
async function checkRobotsTxt(domain) {
  try {
    const url = `https://${domain}/robots.txt`;
    const res = await fetchUrl(url);
    if (res.status === 200) {
      // Parse simple disallow rules
      const lines = res.data.split('\n');
      let disallowAll = false;
      const disallowPaths = [];
      for (const line of lines) {
        const trimmed = line.trim().toLowerCase();
        if (trimmed.startsWith('disallow:')) {
          const path = trimmed.substring(9).trim();
          if (path === '/') disallowAll = true;
          else if (path) disallowPaths.push(path);
        }
      }
      return { disallowAll, disallowPaths };
    }
    return { disallowAll: false, disallowPaths: [] };
  } catch (e) {
    console.log(`  ⚠ robots.txt fetch failed for ${domain}: ${e.message}`);
    return { disallowAll: false, disallowPaths: [] };
  }
}

// Check if URL is disallowed
function isDisallowed(path, robotsRules) {
  if (robotsRules.disallowAll) return true;
  for (const disallowPath of robotsRules.disallowPaths) {
    if (path.startsWith(disallowPath)) return true;
  }
  return false;
}

// Extract styles from text (case-insensitive)
function extractStyles(text) {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const found = new Set();

  for (const [pattern, canonical] of Object.entries(CANONICAL_STYLES)) {
    if (lowerText.includes(pattern)) {
      found.add(canonical);
    }
  }

  return Array.from(found);
}

// Extract portfolio images from HTML
function extractImages(html, artistName, baseUrl) {
  const images = [];
  if (!html || !artistName) return images;

  // Look for img tags with src or srcset
  const imgRegex = /<img[^>]*>/gi;
  const matches = html.match(imgRegex) || [];

  for (const match of matches) {
    const srcMatch = match.match(/src=["']([^"']+)["']/i);
    const srcsetMatch = match.match(/srcset=["']([^"']+)["']/i);

    const urls = [];
    if (srcMatch) urls.push(srcMatch[1]);
    if (srcsetMatch) {
      const sources = srcsetMatch[1].split(',');
      for (const src of sources) {
        const url = src.trim().split(/\s+/)[0];
        if (url) urls.push(url);
      }
    }

    for (let url of urls) {
      // Skip common non-portfolio images
      if (url.includes('logo') || url.includes('icon') || url.includes('avatar') ||
          url.includes('favicon') || url.includes('placeholder')) {
        continue;
      }

      // Make absolute URL
      try {
        url = new URL(url, baseUrl).href;
      } catch (e) {
        continue;
      }

      if (url && !images.includes(url) && images.length < 8) {
        images.push(url);
      }
    }
  }

  return images.slice(0, 8);
}

// Extract bio
function extractBio(html, artistName) {
  if (!html || !artistName) return null;

  // Look for paragraphs or divs that might contain bio
  const sections = html.split(/<\/?(p|div|section|article)[^>]*>/i);

  for (const section of sections) {
    if (section.toLowerCase().includes(artistName.toLowerCase()) ||
        section.toLowerCase().includes('bio') ||
        section.toLowerCase().includes('artist')) {
      const text = section.replace(/<[^>]*>/g, '').trim();
      if (text.length > 20 && text.length < 500) {
        return text.substring(0, 500);
      }
    }
  }

  return null;
}

// Extract booking URL
function extractBookingUrl(html, baseUrl) {
  const patterns = [
    /href=["']([^"']*(?:book|appointment|contact|inquir|booking|schedule)[^"']*?)["']/gi,
    /href=["']([^"']*(?:contact|email|message)[^"']*?)["']/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      try {
        return new URL(match[1], baseUrl).href;
      } catch (e) {
        // Ignore invalid URLs
      }
    }
  }

  return null;
}

// Sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main extraction
async function extractEnrichment() {
  const domains = Object.keys(batch.domains);

  console.log(`Processing ${domains.length} domains with ${Object.values(batch.domains).reduce((sum, artists) => sum + artists.length, 0)} artists...\n`);

  for (const domain of domains) {
    console.log(`Processing domain: ${domain}`);
    const artists = batch.domains[domain];

    // Check robots.txt
    const robotsRules = await checkRobotsTxt(domain);
    if (robotsRules.disallowAll) {
      console.log(`  ✗ robots.txt disallows all requests`);
      stats.domainsFailed.push(`${domain} (robots.txt)`);
      continue;
    }

    // Get unique pages (max 6)
    const uniquePages = new Set();
    for (const artist of artists) {
      if (artist.pages && artist.pages.length > 0) {
        for (const page of artist.pages.slice(0, 2)) {
          uniquePages.add(page);
          if (uniquePages.size >= 6) break;
        }
      }
      if (uniquePages.size >= 6) break;
    }

    if (uniquePages.size === 0) {
      console.log(`  ⚠ No pages found for artists`);
      stats.domainsFailed.push(`${domain} (no pages)`);
      continue;
    }

    console.log(`  Fetching ${uniquePages.size} pages...`);

    let consecutiveFailures = 0;
    const pageContents = {};

    for (const page of uniquePages) {
      try {
        const pageUrl = new URL(page);
        const pathname = pageUrl.pathname;

        if (isDisallowed(pathname, robotsRules)) {
          console.log(`    - Skipped (robots.txt): ${page}`);
          continue;
        }

        console.log(`    - Fetching: ${page.substring(0, 60)}...`);
        const res = await fetchUrl(page);

        if (res.status === 200) {
          pageContents[page] = res.data;
          consecutiveFailures = 0;
        } else {
          console.log(`      → Status ${res.status}`);
          consecutiveFailures++;
          if (consecutiveFailures >= 2) {
            console.log(`      → Stopping after 2 failures`);
            break;
          }
        }

        await sleep(SLEEP_MS);
      } catch (e) {
        console.log(`      → Error: ${e.message}`);
        consecutiveFailures++;
        if (consecutiveFailures >= 2) {
          console.log(`      → Stopping after 2 failures`);
          break;
        }
      }
    }

    // Extract enrichment for each artist
    console.log(`  Extracting data for ${artists.length} artists...`);
    for (const artist of artists) {
      if (!artist.id || !artist.name) continue;

      let hasEnriched = false;
      const evidence = [];
      let aggregatedStyles = new Set(artist.styles || []);
      let portfolioImages = [];
      let bio = null;
      let bookingUrl = null;

      // Search through fetched pages
      for (const [page, html] of Object.entries(pageContents)) {
        // Check if artist name appears on page
        if (!html.toLowerCase().includes(artist.name.toLowerCase())) continue;

        evidence.push(page);

        // Extract styles
        const styles = extractStyles(html);
        styles.forEach(s => aggregatedStyles.add(s));

        // Extract images
        const images = extractImages(html, artist.name, page);
        portfolioImages.push(...images);

        // Extract bio
        if (!bio) bio = extractBio(html, artist.name);

        // Extract booking URL
        if (!bookingUrl) bookingUrl = extractBookingUrl(html, page);
      }

      // Only add to results if we found enrichment
      if (evidence.length > 0 || aggregatedStyles.size > (artist.styles?.length || 0) || portfolioImages.length > 0) {
        hasEnriched = true;

        const oldStyleCount = artist.styles?.length || 0;
        const newStyleCount = aggregatedStyles.size;
        if (newStyleCount > oldStyleCount) {
          stats.newStyles += (newStyleCount - oldStyleCount);
        }

        const oldImageCount = artist.images || 0;
        if (portfolioImages.length > oldImageCount) {
          stats.newImages += (portfolioImages.length - oldImageCount);
        }

        results.artists[artist.id] = {
          styles: Array.from(aggregatedStyles),
          portfolioImages: Array.from(new Set(portfolioImages)).slice(0, 8),
          bio: bio,
          bookingUrl: bookingUrl,
          evidence: evidence,
        };

        if (hasEnriched) {
          stats.artistsEnriched++;

          // Track sample
          if (stats.samples.length < 3) {
            stats.samples.push({
              name: artist.name,
              shopName: artist.shopName,
              styles: Array.from(aggregatedStyles),
              imageCount: portfolioImages.length,
              evidence: evidence.slice(0, 2),
            });
          }
        }
      }
    }

    stats.domainsDone++;
    console.log(`  ✓ Done (enriched ${artists.filter(a => results.artists[a.id]).length}/${artists.length} artists)\n`);
  }

  // Write results
  console.log(`\nWriting results to ${SHARD_FILE}...`);
  fs.mkdirSync(path.dirname(SHARD_FILE), { recursive: true });
  fs.writeFileSync(SHARD_FILE, JSON.stringify(results, null, 2));

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log(`Batch: ${results.batch}`);
  console.log(`Domains processed: ${stats.domainsDone}/${domains.length}`);
  console.log(`Domains failed: ${stats.domainsFailed.length}`);
  if (stats.domainsFailed.length > 0) {
    stats.domainsFailed.forEach(d => console.log(`  - ${d}`));
  }
  console.log(`Artists enriched: ${stats.artistsEnriched}`);
  console.log(`New styles added: ${stats.newStyles}`);
  console.log(`New images found: ${stats.newImages}`);
  console.log(`\nSamples:`);
  stats.samples.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name} @ ${s.shopName}`);
    console.log(`     Styles: ${s.styles.join(', ') || 'none'}`);
    console.log(`     Images: ${s.imageCount}`);
  });

  // Return structured output
  return {
    batch: results.batch,
    domainsDone: stats.domainsDone,
    domainsFailed: stats.domainsFailed,
    artistsEnriched: stats.artistsEnriched,
    newStyles: stats.newStyles,
    newImages: stats.newImages,
    shardPath: SHARD_FILE,
    samples: stats.samples,
  };
}

// Run
extractEnrichment().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
