import axios from 'axios';
import { config } from '../config.js';   // ← reads user-config.json

export default class TraxrModule {
    constructor() {
        // Read flag from user-config.json (default = true)
        this.enabled = config.traxrEnabled !== false;   // respects "traxrEnabled": false

        this.baseUrl = 'https://solana.traxr.pro/api/traxr';

        if (this.enabled) {
            console.log('✅ TraxrModule initialized — TRAXR security layer ACTIVE');
        } else {
            console.log('⚠️  TraxrModule initialized — TRAXR security layer DISABLED (traxrEnabled: false)');
        }
    }

    /**
     * Get risk score by token pair
     */
    async getPoolScore(mintA, mintB, dataset = null) {
        if (!this.enabled) return { disabled: true, message: 'Traxr is disabled in user-config.json' };
        if (!mintA || !mintB) return { error: 'mintA and mintB required' };

        try {
            const params = { mintA, mintB };
            if (dataset) params.dataset = dataset;

            const response = await axios.get(`${this.baseUrl}/score`, {
                params,
                timeout: 10000,
            });
            return response.data;
        } catch (error) {
            this._handleError('getPoolScore', `${mintA}/${mintB}`, error);
            return { error: error.message || 'Failed to fetch pool score' };
        }
    }

    /**
     * Get pool details by pool address (used in screening)
     */
    async getPoolById(poolId, dataset = null) {
        if (!this.enabled) return { disabled: true, message: 'Traxr is disabled in user-config.json' };
        if (!poolId) return { error: 'poolId required' };

        try {
            const url = `${this.baseUrl}/pools/${encodeURIComponent(poolId)}`;
            const params = dataset ? { dataset } : {};

            const response = await axios.get(url, { params, timeout: 10000 });
            return response.data;
        } catch (error) {
            this._handleError('getPoolById', poolId, error);
            return { error: error.message || 'Failed to fetch pool by ID' };
        }
    }

    /**
     * Get active alerts
     */
    async getAlerts() {
        if (!this.enabled) return { disabled: true, message: 'Traxr is disabled in user-config.json' };

        try {
            const response = await axios.get(`${this.baseUrl}/alerts`, { timeout: 8000 });
            return response.data;
        } catch (error) {
            this._handleError('getAlerts', 'global', error);
            return { error: error.message || 'Failed to fetch alerts' };
        }
    }

    /**
     * Get pool trend data
     */
    async getPoolTrend(poolId, dataset = null) {
        if (!this.enabled) return { disabled: true, message: 'Traxr is disabled in user-config.json' };
        if (!poolId) return { error: 'poolId required' };

        try {
            const params = { poolId };
            if (dataset) params.dataset = dataset;

            const response = await axios.get(`${this.baseUrl}/pool-trend`, { params, timeout: 10000 });
            return response.data;
        } catch (error) {
            this._handleError('getPoolTrend', poolId, error);
            return { error: error.message || 'Failed to fetch pool trend' };
        }
    }

    _handleError(method, identifier, error) {
        const status = error.response?.status || 'N/A';
        const msg = error.response?.data?.error || error.message || 'Unknown error';
        console.warn(`⚠️ [TRAXR API ERROR] ${method}(${identifier}) — ${status}: ${msg}`);
    }
}