/**
 * Style-Model Mapping Utility
 * 
 * Provides intelligent model selection based on tattoo style, complexity, and body part.
 * Implements caching for model availability to reduce API calls.
 */

import {
    MODEL_CONFIGS,
    STYLE_MODEL_MAPPING,
    MODEL_FALLBACK_CHAIN,
    MODEL_PROMPT_MODIFIERS,
    MODEL_NEGATIVE_PROMPTS,
    COMPLEXITY_ADJUSTMENTS,
    BODY_PART_CONSIDERATIONS
} from '../config/modelRoutingRules.js';

// Model availability cache (1 minute TTL)
const MODEL_AVAILABILITY_CACHE = {
    cache: new Map(),
    TTL: 60000, // 1 minute

    set(modelId, isAvailable) {
        this.cache.set(modelId, {
            available: isAvailable,
            timestamp: Date.now()
        });
    },

    get(modelId) {
        const entry = this.cache.get(modelId);
        if (!entry) return null;

        // Check if cache entry is still valid
        if (Date.now() - entry.timestamp > this.TTL) {
            this.cache.delete(modelId);
            return null;
        }

        return entry.available;
    },

    clear() {
        this.cache.clear();
    }
};

/**
 * Determine prompt complexity based on length and character count
 * @param {string} prompt - The prompt to analyze
 * @returns {string} Complexity level: 'simple', 'moderate', or 'complex'
 */
function determineComplexity(prompt) {
    if (!prompt) return 'simple';

    const length = prompt.length;
    const wordCount = prompt.split(/\s+/).length;
    const hasMultipleCharacters = prompt.toLowerCase().includes('and') ||
        prompt.toLowerCase().includes('with');

    if (length > 500 || wordCount > 80 || hasMultipleCharacters) {
        return 'complex';
    } else if (length > 200 || wordCount > 30) {
        return 'moderate';
    }

    return 'simple';
}

/**
 * Check if body part is in a specific category
 * @param {string} bodyPart - Body part to check
 * @returns {string} Category: 'large', 'small', or 'medium'
 */
function getBodyPartCategory(bodyPart) {
    if (!bodyPart) return 'medium';

    const normalized = bodyPart.toLowerCase();

    if (BODY_PART_CONSIDERATIONS.largeAreas.includes(normalized)) {
        return 'large';
    } else if (BODY_PART_CONSIDERATIONS.smallAreas.includes(normalized)) {
        return 'small';
    }

    return 'medium';
}

/**
 * Select optimal AI model based on style, complexity, and body part
 * 
 * @param {string} style - Tattoo style (e.g., 'traditional', 'anime', 'realism')
 * @param {string} complexity - Prompt complexity ('simple', 'moderate', 'complex')
 * @param {string} bodyPart - Body part for placement
 * @returns {Object} Selected model info with reasoning
 */
export function selectOptimalModel(style, complexity = 'moderate', bodyPart = 'forearm') {
    console.log('[StyleModelMapping] Selecting model for:', { style, complexity, bodyPart });

    // Normalize style input
    const normalizedStyle = style?.toLowerCase() || 'default';

    // Get style-based model mapping
    const styleMapping = STYLE_MODEL_MAPPING[normalizedStyle] || STYLE_MODEL_MAPPING.default;
    let selectedModelId = styleMapping.primary;
    let reasoning = styleMapping.reasoning;

    // Apply complexity adjustments
    const complexityConfig = COMPLEXITY_ADJUSTMENTS[complexity];
    if (complexityConfig && complexityConfig.modelPreference) {
        // Check if current selection is in preferred list
        if (!complexityConfig.modelPreference.includes(selectedModelId)) {
            // Try to find a preferred model that matches the style
            const preferredModel = complexityConfig.modelPreference.find(modelId => {
                const modelConfig = MODEL_CONFIGS[modelId];
                return modelConfig && modelConfig.bestFor.some(s =>
                    normalizedStyle.includes(s) || s.includes(normalizedStyle)
                );
            });

            if (preferredModel) {
                selectedModelId = preferredModel;
                reasoning = `${reasoning} (optimized for ${complexity} complexity)`;
            }
        }
    }

    // Apply body part considerations
    const bodyPartCategory = getBodyPartCategory(bodyPart);
    if (bodyPartCategory === 'small' && BODY_PART_CONSIDERATIONS.preferBold) {
        // For small areas, prefer models with bold line work
        if (selectedModelId === 'imagen3' || selectedModelId === 'dreamshaper_turbo') {
            selectedModelId = 'tattoo_flash_art';
            reasoning = `${reasoning} (simplified for small body part)`;
        }
    } else if (bodyPartCategory === 'large' && BODY_PART_CONSIDERATIONS.preferDetailed) {
        // For large areas, prefer detailed models
        if (selectedModelId === 'tattoo_flash_art' && normalizedStyle !== 'traditional') {
            selectedModelId = 'blackwork_specialist';
            reasoning = `${reasoning} (enhanced detail for large area)`;
        }
    }

    const modelConfig = MODEL_CONFIGS[selectedModelId];

    return {
        modelId: selectedModelId,
        modelName: modelConfig.name,
        modelConfig: modelConfig,
        reasoning: reasoning,
        fallbackChain: MODEL_FALLBACK_CHAIN[selectedModelId] || [],
        estimatedTime: modelConfig.estimatedTime,
        cost: modelConfig.cost
    };
}

/**
 * Get model capabilities and metadata
 * 
 * @param {string} modelId - Model identifier
 * @returns {Object} Model capabilities and metadata
 */
export function getModelCapabilities(modelId) {
    const modelConfig = MODEL_CONFIGS[modelId];

    if (!modelConfig) {
        console.warn(`[StyleModelMapping] Unknown model: ${modelId}`);
        return null;
    }

    return {
        id: modelConfig.id,
        name: modelConfig.name,
        description: modelConfig.description,
        provider: modelConfig.provider,
        strengths: modelConfig.strengths,
        limitations: modelConfig.limitations,
        bestFor: modelConfig.bestFor,
        estimatedTime: modelConfig.estimatedTime,
        cost: modelConfig.cost,
        promptModifiers: MODEL_PROMPT_MODIFIERS[modelId],
        negativePrompt: MODEL_NEGATIVE_PROMPTS[modelId]
    };
}

/**
 * Validate if a model is accessible (with caching)
 * 
 * @param {string} modelId - Model identifier to validate
 * @returns {Promise<boolean>} True if model is accessible
 */
export async function validateModelAvailability(modelId) {
    // Check cache first
    const cached = MODEL_AVAILABILITY_CACHE.get(modelId);
    if (cached !== null) {
        console.log(`[StyleModelMapping] Model ${modelId} availability (cached): ${cached}`);
        return cached;
    }

    // For now, assume all configured models are available
    // In production, this would make an API call to check model status
    const modelConfig = MODEL_CONFIGS[modelId];
    const isAvailable = !!modelConfig;

    // Cache the result
    MODEL_AVAILABILITY_CACHE.set(modelId, isAvailable);

    console.log(`[StyleModelMapping] Model ${modelId} availability: ${isAvailable}`);
    return isAvailable;
}

/**
 * Get fallback model if primary is unavailable
 * 
 * @param {string} modelId - Primary model identifier
 * @returns {Promise<string>} Fallback model identifier
 */
export async function getModelFallback(modelId) {
    const fallbackChain = MODEL_FALLBACK_CHAIN[modelId];

    if (!fallbackChain || fallbackChain.length === 0) {
        console.warn(`[StyleModelMapping] No fallback chain for ${modelId}, using default`);
        return 'blackwork_specialist'; // Default fallback
    }

    // Try each fallback in order
    for (const fallbackId of fallbackChain) {
        const isAvailable = await validateModelAvailability(fallbackId);
        if (isAvailable) {
            console.log(`[StyleModelMapping] Using fallback model: ${fallbackId}`);
            return fallbackId;
        }
    }

    // If all fallbacks fail, use default
    console.warn(`[StyleModelMapping] All fallbacks failed for ${modelId}, using default`);
    return 'blackwork_specialist';
}

/**
 * Get model-specific prompt enhancements
 * 
 * @param {string} modelId - Model identifier
 * @param {string} basePrompt - Base prompt to enhance
 * @param {boolean} isCouncilEnhanced - Whether prompt is already council-enhanced
 * @returns {Object} Enhanced prompt and negative prompt
 */
export function getModelPromptEnhancements(modelId, basePrompt, isCouncilEnhanced = false) {
    const modifiers = MODEL_PROMPT_MODIFIERS[modelId];
    const negativePrompt = MODEL_NEGATIVE_PROMPTS[modelId];

    if (!modifiers) {
        console.warn(`[StyleModelMapping] No prompt modifiers for ${modelId}`);
        return {
            enhancedPrompt: basePrompt,
            negativePrompt: negativePrompt || ''
        };
    }

    // If already council-enhanced, don't add too many modifiers
    // Just ensure model-specific keywords are present
    let enhancedPrompt = basePrompt;

    if (!isCouncilEnhanced) {
        // Add model-specific positive modifiers
        enhancedPrompt = `${basePrompt}, ${modifiers.positive}`;
    } else {
        // For council-enhanced prompts, only add if not already present
        const lowerPrompt = basePrompt.toLowerCase();
        const keyModifiers = modifiers.positive.split(',')[0]; // Just the first key modifier

        if (!lowerPrompt.includes(keyModifiers.toLowerCase())) {
            enhancedPrompt = `${basePrompt}, ${keyModifiers}`;
        }
    }

    return {
        enhancedPrompt,
        negativePrompt
    };
}

/**
 * Select model with automatic fallback handling.
 *
 * A TypeSafe Choice can pass `options.preferredModelId`. That choice wins
 * when the id is a configured, available model. Anything else — missing
 * choice, low confidence (the caller omits the id), unknown id, or an
 * unavailable model — keeps this rules table.
 *
 * @param {string} style - Tattoo style
 * @param {string} prompt - User prompt (for complexity analysis)
 * @param {string} bodyPart - Body part for placement
 * @param {{ preferredModelId?: string, reasoning?: string, choiceConfidence?: number, choiceProbabilities?: Record<string, number> }} [options]
 * @returns {Promise<Object>} Selected model with fallback if needed
 */
export async function selectModelWithFallback(style, prompt = '', bodyPart = 'forearm', options = {}) {
    const preferred = options.preferredModelId;
    if (preferred && MODEL_CONFIGS[preferred]) {
        const isPreferredAvailable = await validateModelAvailability(preferred);
        if (isPreferredAvailable) {
            const preferredConfig = MODEL_CONFIGS[preferred];
            return {
                modelId: preferred,
                modelName: preferredConfig.name,
                modelConfig: preferredConfig,
                reasoning: options.reasoning || `TypeSafe judge selected ${preferredConfig.name}`,
                fallbackChain: MODEL_FALLBACK_CHAIN[preferred] || [],
                estimatedTime: preferredConfig.estimatedTime,
                cost: preferredConfig.cost,
                isFallback: false,
                source: 'typesafe',
                choiceConfidence: options.choiceConfidence ?? null,
                choiceProbabilities: options.choiceProbabilities ?? null
            };
        }
    }

    const complexity = determineComplexity(prompt);
    const selection = selectOptimalModel(style, complexity, bodyPart);

    // Validate primary model availability
    const isPrimaryAvailable = await validateModelAvailability(selection.modelId);

    if (isPrimaryAvailable) {
        return {
            ...selection,
            isFallback: false,
            source: 'rules',
            typesafeChoiceIgnored: Boolean(preferred)
        };
    }

    // Primary unavailable, get fallback
    console.warn(`[StyleModelMapping] Primary model ${selection.modelId} unavailable, using fallback`);
    const fallbackId = await getModelFallback(selection.modelId);
    const fallbackConfig = MODEL_CONFIGS[fallbackId];

    return {
        modelId: fallbackId,
        modelName: fallbackConfig.name,
        modelConfig: fallbackConfig,
        reasoning: `${selection.reasoning} (fallback: primary model unavailable)`,
        fallbackChain: MODEL_FALLBACK_CHAIN[fallbackId] || [],
        estimatedTime: fallbackConfig.estimatedTime,
        cost: fallbackConfig.cost,
        isFallback: true,
        originalModel: selection.modelId,
        source: 'rules',
        typesafeChoiceIgnored: Boolean(preferred)
    };
}

/**
 * Clear model availability cache
 * Useful for testing or when model status changes
 */
export function clearModelCache() {
    MODEL_AVAILABILITY_CACHE.clear();
    console.log('[StyleModelMapping] Model availability cache cleared');
}

/**
 * Get all available models for a specific style
 * 
 * @param {string} style - Tattoo style
 * @returns {Array} List of compatible models with rankings
 */
export function getCompatibleModels(style) {
    const normalizedStyle = style?.toLowerCase() || 'default';
    const compatibleModels = [];

    // Find all models that support this style
    Object.entries(MODEL_CONFIGS).forEach(([modelId, config]) => {
        const isCompatible = config.bestFor.some(s =>
            normalizedStyle.includes(s) || s.includes(normalizedStyle)
        );

        if (isCompatible) {
            const styleMapping = STYLE_MODEL_MAPPING[normalizedStyle];
            const isPrimary = styleMapping && styleMapping.primary === modelId;

            compatibleModels.push({
                modelId,
                modelName: config.name,
                description: config.description,
                isPrimary,
                estimatedTime: config.estimatedTime,
                cost: config.cost
            });
        }
    });

    // Sort by primary first, then by cost
    return compatibleModels.sort((a, b) => {
        if (a.isPrimary && !b.isPrimary) return -1;
        if (!a.isPrimary && b.isPrimary) return 1;
        return a.cost - b.cost;
    });
}
