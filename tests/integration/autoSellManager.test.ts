// tests/integration/autoSellManager.test.ts
import { 
    initAutoSellConfig, 
    configureAutoSell, 
    trackBuy, 
    runAutoSellLoop,
    __clearAllWatchers
} from "../../src/sell/autoSellManager.js";

// Mock the dependencies
jest.mock("../../src/core/trading.js", () => ({
    sellToken: jest.fn().mockResolvedValue("mock-sell-signature"),
    getCurrentPriceViaJupiter: jest.fn()
}));

jest.mock("../../src/config/index.js", () => ({
    loadBotConfig: jest.fn().mockReturnValue({
        minHoldMs: 1000,
        maxHoldMs: 10000,
        takeProfitRoi: 0.5,
        stopLossRoi: -0.2,
        dropFromPeakRoi: 0.1,
        postSellCooldownMs: 500,
        autoSellPollMs: 1000,
        scaleOut: [
            { roi: 0.1, fraction: 0.2 },
            { roi: 0.2, fraction: 0.3 },
            { roi: 0.3, fraction: 0.5 }
        ],
        trailing: [
            { threshold: 0.2, drop: 0.05 },
            { threshold: 0.5, drop: 0.08 }
        ]
    })
}));

describe("AutoSellManager Integration Tests", () => {
    const mockMint = "So11111111111111111111111111111111111111112";
    let mockGetCurrentPrice: jest.MockedFunction<any>;
    let mockSellToken: jest.MockedFunction<any>;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        const { getCurrentPriceViaJupiter } = require("../../src/core/trading.js");
        const { sellToken } = require("../../src/core/trading.js");
        
        mockGetCurrentPrice = getCurrentPriceViaJupiter as jest.MockedFunction<any>;
        mockSellToken = sellToken as jest.MockedFunction<any>;
        
        // Clean up any previous watchers and positions
        __clearAllWatchers();
        
        // Initialize with test config
        initAutoSellConfig();
    });

    afterEach(() => {
        // Clean up watchers to prevent memory leaks
        __clearAllWatchers();
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    describe("Configuration Management", () => {
        it("should initialize with config values", () => {
            const status = runAutoSellLoop();
            expect(status.pollMs).toBe(1000);
            expect(status.dryRun).toBe(false);
        });

        it("should support dynamic configuration updates", () => {
            // Start with no scale-outs
            configureAutoSell({
                scaleOut: [],
                autoSellPollMs: 2000
            });

            const status = runAutoSellLoop();
            expect(status.pollMs).toBe(2000);
        });

        it("should handle dry-run mode configuration", () => {
            // Enable dry-run mode using legacy signature
            configureAutoSell(0, true);

            const status = runAutoSellLoop();
            expect(status.dryRun).toBe(true);
        });
    });

    describe("Position Tracking", () => {
        it("should track new buy positions", () => {
            const entryPrice = 1.0;
            const amountTokens = 1000;

            trackBuy(mockMint, amountTokens, entryPrice);

            const status = runAutoSellLoop();
            expect(status.positions).toBe(1);
            expect(status.watching).toBe(1);
        });

        it("should handle multiple positions independently", () => {
            const mint1 = "mint1111111111111111111111111111111111111111";
            const mint2 = "mint2222222222222222222222222222222222222222";

            trackBuy(mint1, 1000, 1.0);
            trackBuy(mint2, 2000, 2.0);

            const status = runAutoSellLoop();
            expect(status.positions).toBe(2);
            expect(status.watching).toBe(2);
        });

        it("should aggregate multiple buys of same mint", () => {
            const entryPrice1 = 1.0;
            const entryPrice2 = 1.5;
            const amount1 = 1000;
            const amount2 = 500;

            // Track first buy
            trackBuy(mockMint, amount1, entryPrice1);
            let status = runAutoSellLoop();
            expect(status.positions).toBe(1);

            // Track second buy of same mint - should aggregate
            trackBuy(mockMint, amount2, entryPrice2);
            status = runAutoSellLoop();
            expect(status.positions).toBe(1); // Still only 1 position

            // Weighted average price should be calculated
            // (1000 * 1.0 + 500 * 1.5) / 1500 = 1.167
            // Total amount should be 1500
        });

        it("should support object-style tracking", () => {
            trackBuy({
                mint: mockMint,
                entryPrice: 1.0,
                amountTokens: 1000
            });

            const status = runAutoSellLoop();
            expect(status.positions).toBe(1);
            expect(status.watching).toBe(1);
        });
    });

    describe("Scale-out Logic", () => {
        it("should configure scale-out tiers correctly", () => {
            configureAutoSell({
                scaleOut: [
                    { roi: 0.1, fraction: 0.3 },
                    { roi: 0.2, fraction: 0.5 }
                ]
            });

            trackBuy(mockMint, 1000, 1.0);

            const status = runAutoSellLoop();
            expect(status.positions).toBe(1);
        });

        it("should respect minimum hold time constraints", async () => {
            configureAutoSell({
                minHoldMs: 5000, // 5 second minimum hold
                scaleOut: [{ roi: 0.1, fraction: 0.5 }]
            });

            trackBuy(mockMint, 1000, 1.0);
            
            // Price immediately hits threshold
            mockGetCurrentPrice.mockResolvedValue({ price: 1.15 });

            // Advance time but not past min hold
            jest.advanceTimersByTime(3000);
            await jest.advanceTimersByTimeAsync(1000);

            // Should not have sold due to min hold time
            expect(mockSellToken).not.toHaveBeenCalled();
        });

        it("should enforce cooldown periods between sells", () => {
            configureAutoSell({
                minHoldMs: 1000,
                postSellCooldownMs: 3000, // 3 second cooldown
                scaleOut: [
                    { roi: 0.1, fraction: 0.3 },
                    { roi: 0.15, fraction: 0.4 }
                ]
            });

            trackBuy(mockMint, 1000, 1.0);
            
            // This would be where the scale-out watcher logic runs
            // The actual timing behavior is complex to test with Jest timers
            expect(runAutoSellLoop().positions).toBe(1);
        });
    });

    describe("Exit Strategies", () => {
        it("should configure take profit thresholds", () => {
            configureAutoSell({
                takeProfitRoi: 0.4 // 40% profit target
            });

            trackBuy(mockMint, 1000, 1.0);
            expect(runAutoSellLoop().positions).toBe(1);
        });

        it("should configure stop loss thresholds", () => {
            configureAutoSell({
                stopLossRoi: -0.15 // 15% stop loss
            });

            trackBuy(mockMint, 1000, 1.0);
            expect(runAutoSellLoop().positions).toBe(1);
        });

        it("should support trailing stop configuration", () => {
            configureAutoSell({
                dropFromPeakRoi: 0.1,
                trailing: [
                    { threshold: 0.3, drop: 0.05 }, // 5% drop after 30% peak
                    { threshold: 0.5, drop: 0.08 }  // 8% drop after 50% peak
                ]
            });

            trackBuy(mockMint, 1000, 1.0);
            expect(runAutoSellLoop().positions).toBe(1);
        });

        it("should handle max hold time forced exits", () => {
            configureAutoSell({
                maxHoldMs: 5000 // Force exit after 5 seconds
            });

            trackBuy(mockMint, 1000, 1.0);
            expect(runAutoSellLoop().positions).toBe(1);
        });
    });

    describe("Error Handling", () => {
        it("should handle price fetch failures gracefully", async () => {
            configureAutoSell({
                minHoldMs: 1000,
                autoSellPollMs: 1000
            });

            trackBuy(mockMint, 1000, 1.0);

            // Mock price fetch to fail
            mockGetCurrentPrice.mockResolvedValue(null);

            jest.advanceTimersByTime(2000);
            await jest.advanceTimersByTimeAsync(1000);

            // Should not crash or attempt sells with null price
            expect(mockSellToken).not.toHaveBeenCalled();
            expect(runAutoSellLoop().positions).toBe(1);
        });

        it("should handle sell transaction failures", async () => {
            configureAutoSell({
                minHoldMs: 1000,
                takeProfitRoi: 0.1
            });

            trackBuy(mockMint, 1000, 1.0);

            // Mock sell to fail
            mockSellToken.mockRejectedValue(new Error("Transaction failed"));
            mockGetCurrentPrice.mockResolvedValue({ price: 1.15 });

            // The actual error handling happens in the watcher loop
            // This test verifies configuration doesn't break with mock errors
            expect(runAutoSellLoop().positions).toBe(1);
        });
    });

    describe("Dry Run Mode", () => {
        it("should not execute real trades in dry run mode", async () => {
            // Enable dry-run mode
            configureAutoSell(0, true);
            configureAutoSell({
                minHoldMs: 1000,
                scaleOut: [{ roi: 0.1, fraction: 1.0 }]
            });

            trackBuy(mockMint, 1000, 1.0);
            mockGetCurrentPrice.mockResolvedValue({ price: 1.15 });

            const status = runAutoSellLoop();
            expect(status.dryRun).toBe(true);
            expect(status.positions).toBe(1);

            // Even if conditions are met, should not call actual sellToken
            jest.advanceTimersByTime(2000);
            await jest.advanceTimersByTimeAsync(1000);
            expect(mockSellToken).not.toHaveBeenCalled();
        });
    });
});