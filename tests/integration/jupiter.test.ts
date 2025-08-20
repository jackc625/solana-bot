// tests/integration/jupiter.test.ts
import { PublicKey, Connection, VersionedTransaction } from "@solana/web3.js";
import { 
    computeSwap, 
    simulateSell, 
    simulateBuySell,
    getLpLiquidity,
    getSharedJupiter
} from "../../src/utils/jupiter.js";

// Mock external dependencies
jest.mock("@jup-ag/core", () => ({
    Jupiter: {
        load: jest.fn()
    }
}));

jest.mock("../../src/utils/solana.js", () => ({
    connection: {
        simulateTransaction: jest.fn()
    }
}));

jest.mock("../../src/config/index.js", () => ({
    loadBotConfig: jest.fn().mockReturnValue({
        slippage: 10
    })
}));

jest.mock("../../src/utils/globalCooldown.js", () => ({
    shouldCooldown: jest.fn().mockReturnValue(false),
    triggerCooldown: jest.fn()
}));

jest.mock("../../src/utils/logger.js", () => ({
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

describe("Jupiter Integration Tests", () => {
    let mockJupiter: any;
    let mockConnection: any;
    let mockUser: PublicKey;
    const mockOutputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
    const mockTokenMint = "TokenMint1111111111111111111111111111111111";

    beforeEach(() => {
        jest.clearAllMocks();

        mockUser = new PublicKey("11111111111111111111111111111112");
        
        // Mock Jupiter instance
        mockJupiter = {
            computeRoutes: jest.fn(),
            exchange: jest.fn()
        };

        // Mock Jupiter.load
        const { Jupiter } = require("@jup-ag/core");
        Jupiter.load.mockResolvedValue(mockJupiter);

        // Mock connection
        const { connection } = require("../../src/utils/solana.js");
        mockConnection = connection;
    });

    describe("Route Simulation Testing", () => {
        it("should compute swap routes successfully", async () => {
            const mockRoute = {
                inAmount: "100000000", // 0.1 SOL
                outAmount: "150000000", // 150 USDC
                marketInfos: [{
                    id: "jupiter",
                    outputMint: mockOutputMint,
                    notEnoughLiquidity: false
                }]
            };

            const mockSwapTx = "base64-encoded-transaction";

            mockJupiter.computeRoutes.mockResolvedValue({
                routesInfos: [mockRoute]
            });

            mockJupiter.exchange.mockResolvedValue({
                swapTransaction: mockSwapTx
            });

            const result = await computeSwap(mockOutputMint, 0.1, mockUser);

            expect(result).toEqual({
                ...mockRoute,
                swapTransaction: mockSwapTx
            });

            expect(mockJupiter.computeRoutes).toHaveBeenCalledWith({
                inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
                outputMint: new PublicKey(mockOutputMint),
                amount: expect.any(Object), // JSBI.BigInt
                slippageBps: 1000 // 10% * 100
            });

            expect(mockJupiter.exchange).toHaveBeenCalledWith({
                routeInfo: mockRoute,
                userPublicKey: mockUser
            });
        });

        it("should handle route computation failures gracefully", async () => {
            mockJupiter.computeRoutes.mockRejectedValue(new Error("Network error"));

            const result = await computeSwap(mockOutputMint, 0.1, mockUser);

            expect(result).toBeNull();
        });

        it("should handle rate limiting with proper cooldown", async () => {
            const { triggerCooldown } = require("../../src/utils/globalCooldown.js");
            
            mockJupiter.computeRoutes.mockRejectedValue(new Error("429 Too Many Requests"));

            const result = await computeSwap(mockOutputMint, 0.1, mockUser);

            expect(result).toBeNull();
            expect(triggerCooldown).toHaveBeenCalledWith(15_000);
        });

        it("should deduplicate recent requests", async () => {
            const mockRoute = {
                inAmount: "100000000",
                outAmount: "150000000",
                marketInfos: [{ id: "jupiter" }]
            };

            mockJupiter.computeRoutes.mockResolvedValue({
                routesInfos: [mockRoute]
            });

            mockJupiter.exchange.mockResolvedValue({
                swapTransaction: "base64-tx"
            });

            // First call should succeed
            const result1 = await computeSwap(mockOutputMint, 0.1, mockUser);
            expect(result1).not.toBeNull();

            // Immediate second call should be deduplicated
            const result2 = await computeSwap(mockOutputMint, 0.1, mockUser);
            expect(result2).toBeNull();

            // Should only call Jupiter once
            expect(mockJupiter.computeRoutes).toHaveBeenCalledTimes(1);
        });

        it("should simulate sell transactions correctly", async () => {
            const mockRoute = {
                inAmount: "1000000000", // 1 token
                outAmount: "50000000",   // 0.05 SOL
                marketInfos: [{ id: "jupiter" }]
            };

            mockJupiter.computeRoutes.mockResolvedValue({
                routesInfos: [mockRoute]
            });

            const result = await simulateSell({
                tokenMint: mockTokenMint,
                tokenAmount: 1.0,
                userPubkey: mockUser
            });

            expect(result).toEqual({
                expectedOut: 0.05,
                success: true
            });

            expect(mockJupiter.computeRoutes).toHaveBeenCalledWith({
                inputMint: new PublicKey(mockTokenMint),
                outputMint: new PublicKey("So11111111111111111111111111111111111111112"),
                amount: expect.any(Object),
                slippageBps: 1000
            });
        });

        it("should handle sell simulation failures", async () => {
            mockJupiter.computeRoutes.mockRejectedValue(new Error("No route found"));

            const result = await simulateSell({
                tokenMint: mockTokenMint,
                tokenAmount: 1.0,
                userPubkey: mockUser
            });

            expect(result).toEqual({
                expectedOut: 0,
                success: false
            });
        });

        it("should simulate buy/sell round trips", async () => {
            // Mock successful buy route
            const buyRoute = {
                inAmount: "100000000",
                outAmount: "1000000000",
                marketInfos: [{ id: "jupiter" }]
            };

            // Mock successful sell route  
            const sellRoute = {
                inAmount: "1000000000", 
                outAmount: "95000000",
                marketInfos: [{ id: "jupiter" }]
            };

            mockJupiter.computeRoutes
                .mockResolvedValueOnce({ routesInfos: [buyRoute] })
                .mockResolvedValueOnce({ routesInfos: [sellRoute] });

            mockJupiter.exchange
                .mockResolvedValueOnce({ swapTransaction: "buy-tx-base64" })
                .mockResolvedValueOnce({ swapTransaction: "sell-tx-base64" });

            // Mock successful transaction simulations
            mockConnection.simulateTransaction
                .mockResolvedValueOnce({ value: { err: null } }) // buy simulation
                .mockResolvedValueOnce({ value: { err: null } }); // sell simulation

            const result = await simulateBuySell(
                mockUser,
                "So11111111111111111111111111111111111111112", // SOL
                mockTokenMint,
                0.1
            );

            expect(result).toEqual({
                passed: true,
                buyPass: true,
                sellPass: true
            });

            expect(mockConnection.simulateTransaction).toHaveBeenCalledTimes(2);
        });

        it("should detect honeypot tokens in simulation", async () => {
            // Mock successful buy but failed sell
            const buyRoute = {
                inAmount: "100000000",
                outAmount: "1000000000",
                marketInfos: [{ id: "jupiter" }]
            };

            const sellRoute = {
                inAmount: "1000000000",
                outAmount: "95000000", 
                marketInfos: [{ id: "jupiter" }]
            };

            mockJupiter.computeRoutes
                .mockResolvedValueOnce({ routesInfos: [buyRoute] })
                .mockResolvedValueOnce({ routesInfos: [sellRoute] });

            mockJupiter.exchange
                .mockResolvedValueOnce({ swapTransaction: "buy-tx-base64" })
                .mockResolvedValueOnce({ swapTransaction: "sell-tx-base64" });

            // Mock buy success but sell failure (honeypot behavior)
            mockConnection.simulateTransaction
                .mockResolvedValueOnce({ value: { err: null } }) // buy succeeds
                .mockResolvedValueOnce({ value: { err: "Instruction error" } }); // sell fails

            const result = await simulateBuySell(
                mockUser,
                "So11111111111111111111111111111111111111112",
                mockTokenMint,
                0.1
            );

            expect(result).toEqual({
                passed: false,
                buyPass: true,
                sellPass: false
            });
        });

        it("should get LP liquidity correctly", async () => {
            const mockRoute = {
                inAmount: "100000000", // 0.1 SOL
                outAmount: "500000000", // 500 tokens
                marketInfos: [{ id: "jupiter" }]
            };

            mockJupiter.computeRoutes.mockResolvedValue({
                routesInfos: [mockRoute]
            });

            const jupiter = await getSharedJupiter(mockUser);
            const liquidity = await getLpLiquidity(
                jupiter,
                "So11111111111111111111111111111111111111112",
                mockTokenMint,
                0.1
            );

            expect(liquidity).toBe(0.5); // 500 tokens / 1e9

            expect(mockJupiter.computeRoutes).toHaveBeenCalledWith({
                inputMint: new PublicKey("So11111111111111111111111111111111111111112"),
                outputMint: new PublicKey(mockTokenMint),
                amount: expect.any(Object),
                slippageBps: 50
            });
        });

        it("should handle no liquidity scenarios", async () => {
            mockJupiter.computeRoutes.mockResolvedValue({
                routesInfos: [] // No routes available
            });

            const jupiter = await getSharedJupiter(mockUser);
            const liquidity = await getLpLiquidity(
                jupiter,
                "So11111111111111111111111111111111111111112",
                mockTokenMint,
                0.1
            );

            expect(liquidity).toBeNull();
        });

        it("should respect global cooldown", async () => {
            const { shouldCooldown } = require("../../src/utils/globalCooldown.js");
            shouldCooldown.mockReturnValue(true);

            const result = await computeSwap(mockOutputMint, 0.1, mockUser);
            expect(result).toBeNull();

            const sellResult = await simulateSell({
                tokenMint: mockTokenMint,
                tokenAmount: 1.0,
                userPubkey: mockUser
            });
            expect(sellResult).toEqual({ expectedOut: 0, success: false });

            // Jupiter should not be called during cooldown
            expect(mockJupiter.computeRoutes).not.toHaveBeenCalled();
        });

        it("should handle consecutive assertion failures", async () => {
            mockJupiter.computeRoutes.mockRejectedValue(new Error("Assertion failed"));

            // Multiple assertion failures should be handled gracefully
            const result1 = await computeSwap(mockOutputMint, 0.1, mockUser);
            const result2 = await computeSwap(mockOutputMint, 0.1, mockUser);
            const result3 = await computeSwap(mockOutputMint, 0.1, mockUser);

            expect(result1).toBeNull();
            expect(result2).toBeNull();  
            expect(result3).toBeNull();
            expect(mockJupiter.computeRoutes).toHaveBeenCalledTimes(3);
        });

        it("should cache and reuse Jupiter instances", async () => {
            const { Jupiter } = require("@jup-ag/core");
            
            // Clear any existing cache
            Jupiter.load.mockClear();
            
            const mockRoute = {
                inAmount: "100000000",
                outAmount: "150000000",
                marketInfos: [{ id: "jupiter" }]
            };

            mockJupiter.computeRoutes.mockResolvedValue({
                routesInfos: [mockRoute]
            });

            mockJupiter.exchange.mockResolvedValue({
                swapTransaction: "tx"
            });

            // Make multiple calls with same user
            await computeSwap(mockOutputMint, 0.1, mockUser);
            await computeSwap(mockTokenMint, 0.2, mockUser);

            // Jupiter.load should only be called once due to caching
            expect(Jupiter.load).toHaveBeenCalledTimes(1);
            expect(Jupiter.load).toHaveBeenCalledWith({
                connection: expect.any(Object),
                cluster: "mainnet-beta",
                user: mockUser
            });
        });
    });
});