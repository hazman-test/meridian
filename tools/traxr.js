import axios from 'axios';

export default class TraxrModule {
    constructor(apiKey) {
        // Warning for missing key
        this.isEnabled = !!(apiKey && apiKey.length > 10 && apiKey !== 'your_actual_key_here');
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.crosswalk.pro/traxr/solana';

        if (!this.isEnabled) {
            console.warn("⚠️ [SECURITY] Traxr API key missing or invalid. Fallback mode: Active.");
        }
    }

    async getPoolProfile(poolAddress) {
        if (!this.isEnabled) return null;
        try {
            const response = await axios.get(`${this.baseUrl}/score/${poolAddress}`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                timeout: 5000
            });
            return response.data;
        } catch (error) {
            // Log warning for API errors (timeouts, 429s, etc)
            console.warn(`⚠️ [TRAXR API ERROR] ${poolAddress}: ${error.message}`);
            return null;
        }
    }
}