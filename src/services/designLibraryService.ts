/**
 * Design Library Service
 *
 * Manages user's saved tattoo designs using browser localStorage.
 * In production, this will be replaced with proper database storage.
 *
 * Storage Structure:
 * - Each design has unique ID
 * - Stores image URLs ONLY (no base64 blobs)
 * - Maintains creation timestamp for sorting
 * - Auto-purges expired designs
 *
 * Budget Note: localStorage is free and works offline.
 * Perfect for MVP before implementing backend.
 */

import { 
  safeLocalStorageGet, 
  safeLocalStorageSet, 
  validateDesign, 
  purgeExpiredDesigns 
} from './storageService';

const LIBRARY_STORAGE_KEY = 'tattester_design_library';
const MAX_DESIGNS = 50; // Limit to prevent localStorage overflow

// ===== Type Definitions =====

export interface DesignMetadata {
  generatedAt?: string;
  prompt?: string;
  style?: string;
  subject?: string;
  bodyPart?: string;
  size?: string;
  savedAt: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface DesignUserInput {
  style?: string;
  subject?: string;
  bodyPart?: string;
  size?: string;
  [key: string]: unknown;
}

export interface Design {
  id: string;
  imageUrl: string;
  metadata: DesignMetadata;
  userInput: DesignUserInput;
  favorite: boolean;
  notes: string;
  tags: string[];
}

export interface LibraryStats {
  total: number;
  favorites: number;
  byStyle: Record<string, number>;
  byBodyPart: Record<string, number>;
  capacity: number;
  remaining: number;
}

export interface ExportData {
  version: string;
  exportedAt: string;
  designs: Design[];
}

export interface ImportResult {
  imported: number;
  total: number;
}

// ===== Internal Helpers =====

/**
 * Generate unique ID
 */
function generateId(): string {
  return `design_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Create design schema
 */
function createDesign(
  imageUrl: string, 
  metadata: Partial<DesignMetadata>, 
  userInput: DesignUserInput
): Design {
  return {
    id: generateId(),
    imageUrl,
    metadata: {
      ...metadata,
      savedAt: new Date().toISOString()
    },
    userInput,
    favorite: false,
    notes: '',
    tags: []
  };
}

// ===== Public API =====

/**
 * Get all designs from library
 */
export function getAllDesigns(): Design[] {
  try {
    // Auto-purge expired designs on read
    purgeExpiredDesigns();
    
    const designs = safeLocalStorageGet(LIBRARY_STORAGE_KEY, []);
    return Array.isArray(designs) ? designs : [];
  } catch (error) {
    console.error('[DesignLibrary] Error loading designs:', error);
    return [];
  }
}

/**
 * Save design to library
 *
 * @param imageUrl - URL or base64 of the image
 * @param metadata - Design metadata from generation
 * @param userInput - Original user input
 * @returns Saved design object
 */
export function saveDesign(
  imageUrl: string, 
  metadata: Partial<DesignMetadata>, 
  userInput: DesignUserInput
): Design {
  try {
    const designs = getAllDesigns();

    // Check if we've hit the limit
    if (designs.length >= MAX_DESIGNS) {
      // Remove oldest non-favorite design
      const oldestIndex = designs.findIndex(d => !d.favorite);
      if (oldestIndex !== -1) {
        designs.splice(oldestIndex, 1);
      } else {
        throw new Error(`Library is full (${MAX_DESIGNS} designs). Please remove some favorites to save new designs.`);
      }
    }

    // Create new design
    const newDesign = createDesign(imageUrl, metadata, userInput);

    // Validate design (no base64 blobs)
    const validation = validateDesign(newDesign);
    if (!validation.valid) {
      throw new Error(`Invalid design: ${validation.errors.join(', ')}`);
    }

    // Add to beginning of array (most recent first)
    designs.unshift(newDesign);

    // Save to localStorage with safety checks
    const result = safeLocalStorageSet(LIBRARY_STORAGE_KEY, designs);
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to save design');
    }

    console.log('[DesignLibrary] Design saved:', newDesign.id, `(${result.sizeKB}KB)`);

    return newDesign;
  } catch (error) {
    console.error('[DesignLibrary] Error saving design:', error);
    throw error;
  }
}

/**
 * Get design by ID
 */
export function getDesignById(designId: string): Design | undefined {
  const designs = getAllDesigns();
  return designs.find(d => d.id === designId);
}

/**
 * Update design
 */
export function updateDesign(designId: string, updates: Partial<Design>): Design {
  try {
    const designs = getAllDesigns();
    const index = designs.findIndex(d => d.id === designId);

    if (index === -1) {
      throw new Error('Design not found');
    }

    // Merge updates
    designs[index] = {
      ...designs[index],
      ...updates,
      id: designId, // Prevent ID from being changed
      metadata: {
        ...designs[index].metadata,
        ...(updates.metadata || {}),
        updatedAt: new Date().toISOString()
      }
    };

    const result = safeLocalStorageSet(LIBRARY_STORAGE_KEY, designs);
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to update design');
    }

    return designs[index];
  } catch (error) {
    console.error('[DesignLibrary] Error updating design:', error);
    throw error;
  }
}

/**
 * Delete design
 */
export function deleteDesign(designId: string): boolean {
  try {
    const designs = getAllDesigns();
    const filtered = designs.filter(d => d.id !== designId);

    const result = safeLocalStorageSet(LIBRARY_STORAGE_KEY, filtered);
    
    if (!result.success) {
      throw new Error(result.error || 'Failed to delete design');
    }

    console.log('[DesignLibrary] Design deleted:', designId);

    return true;
  } catch (error) {
    console.error('[DesignLibrary] Error deleting design:', error);
    return false;
  }
}

/**
 * Toggle favorite status
 */
export function toggleFavorite(designId: string): Design {
  const design = getDesignById(designId);
  if (!design) throw new Error('Design not found');

  return updateDesign(designId, {
    favorite: !design.favorite
  });
}

/**
 * Add note to design
 */
export function addNote(designId: string, note: string): Design {
  return updateDesign(designId, { notes: note });
}

/**
 * Add tags to design
 */
export function addTags(designId: string, tags: string[]): Design {
  const design = getDesignById(designId);
  if (!design) throw new Error('Design not found');

  const uniqueTags = [...new Set([...design.tags, ...tags])];

  return updateDesign(designId, { tags: uniqueTags });
}

/**
 * Get designs by style
 */
export function getDesignsByStyle(style: string): Design[] {
  const designs = getAllDesigns();
  return designs.filter(d => d.userInput.style === style);
}

/**
 * Get favorite designs
 */
export function getFavoriteDesigns(): Design[] {
  const designs = getAllDesigns();
  return designs.filter(d => d.favorite);
}

/**
 * Get recent designs
 */
export function getRecentDesigns(limit: number = 10): Design[] {
  const designs = getAllDesigns();
  return designs.slice(0, limit);
}

/**
 * Keyword candidate filter for the design library. Order is library order.
 * Server rerank of this shortlist lives in `searchDesignCandidates`
 * (`src/services/matching/designSearch.ts`). This function stays synchronous
 * so the browser path never calls TypeSafe.
 */
export function filterDesignsByQuery(designs: Design[], query: string): Design[] {
  const lowerQuery = (query || '').toLowerCase();

  return designs.filter(d => {
    const searchableText = [
      d.userInput.subject,
      d.userInput.style,
      d.userInput.bodyPart,
      d.notes,
      ...d.tags
    ].filter(Boolean).join(' ').toLowerCase();

    return searchableText.includes(lowerQuery);
  });
}

/**
 * Search designs saved in the local library.
 */
export function searchDesigns(query: string): Design[] {
  return filterDesignsByQuery(getAllDesigns(), query);
}

/**
 * Get library statistics
 */
export function getLibraryStats(): LibraryStats {
  const designs = getAllDesigns();

  const styleCount: Record<string, number> = {};
  const bodyPartCount: Record<string, number> = {};
  let favoriteCount = 0;

  designs.forEach(d => {
    // Count by style
    const style = d.userInput.style;
    if (style) {
      styleCount[style] = (styleCount[style] || 0) + 1;
    }

    // Count by body part
    const bodyPart = d.userInput.bodyPart;
    if (bodyPart) {
      bodyPartCount[bodyPart] = (bodyPartCount[bodyPart] || 0) + 1;
    }

    // Count favorites
    if (d.favorite) favoriteCount++;
  });

  return {
    total: designs.length,
    favorites: favoriteCount,
    byStyle: styleCount,
    byBodyPart: bodyPartCount,
    capacity: MAX_DESIGNS,
    remaining: MAX_DESIGNS - designs.length
  };
}

/**
 * Export library as JSON
 */
export function exportLibrary(): void {
  const designs = getAllDesigns();
  const exportData: ExportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    designs
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json'
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tattester-library-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Import library from JSON
 */
export function importLibrary(file: File): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const result = event.target?.result;
        if (typeof result !== 'string') {
          throw new Error('Failed to read file');
        }
        
        const importData = JSON.parse(result) as ExportData;

        if (!importData.designs || !Array.isArray(importData.designs)) {
          throw new Error('Invalid library format');
        }

        // Merge with existing designs
        const existingDesigns = getAllDesigns();
        const mergedDesigns = [...importData.designs, ...existingDesigns];

        // Remove duplicates and limit
        const uniqueDesigns = mergedDesigns
          .filter((design, index, self) =>
            index === self.findIndex(d => d.id === design.id)
          )
          .slice(0, MAX_DESIGNS);

        const saveResult = safeLocalStorageSet(LIBRARY_STORAGE_KEY, uniqueDesigns);
        
        if (!saveResult.success) {
          throw new Error(saveResult.error || 'Failed to import library');
        }

        resolve({
          imported: importData.designs.length,
          total: uniqueDesigns.length
        });
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * Clear entire library
 */
export function clearLibrary(): boolean {
  if (typeof window !== 'undefined' && window.confirm('Are you sure you want to delete all saved designs? This cannot be undone.')) {
    localStorage.removeItem(LIBRARY_STORAGE_KEY);
    return true;
  }
  return false;
}
