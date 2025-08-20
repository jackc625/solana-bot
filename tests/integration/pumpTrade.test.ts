// tests/integration/pumpTrade.test.ts
import { Connection, Keypair } from "@solana/web3.js";
import { sendPumpTrade } from "../../src/utils/pumpTrade.js";

// Mock the external dependencies
jest.mock("../../src/utils/priorityFee.js", () => ({
    calcPriorityFeeSOL: jest.fn().mockResolvedValue(0.001)
}));

jest.mock("../../src/utils/withTimeout.js", () => ({
    fetchWithTimeout: jest.fn()
}));

// Mock @solana/web3.js
jest.mock("@solana/web3.js", () => {
    const actual = jest.requireActual("@solana/web3.js");
    const mockTx = {
        sign: jest.fn()
    };
    
    return {
        ...actual,
        VersionedTransaction: {
            deserialize: jest.fn(() => mockTx)
        }
    };
});

describe("PumpTrade Integration Tests", () => {
    let mockConnection: Connection;
    let mockWallet: Keypair;
    const mockMint = "So11111111111111111111111111111111111111112";
    
    beforeEach(() => {
        // Create mock connection
        mockConnection = {
            sendTransaction: jest.fn().mockResolvedValue("mock-signature-123")
        } as any;
        
        // Create mock wallet
        mockWallet = {
            publicKey: {
                toBase58: jest.fn().mockReturnValue("mock-public-key")
            },
            secretKey: new Uint8Array(64)
        } as any;
        
        jest.clearAllMocks();
    });

    describe("Timeout and Retry Behavior", () => {
        it("should handle successful trade execution", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            
            fetchWithTimeout.mockResolvedValue({
                ok: true,
                status: 200,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
            });

            const result = await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy"
            });

            expect(result).toBe("mock-signature-123");
            expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
            expect(mockConnection.sendTransaction).toHaveBeenCalledTimes(1);
        });

        it("should handle 429 rate limit and retry with backoff", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            
            // Mock first call to return 429, second to succeed
            fetchWithTimeout
                .mockResolvedValueOnce({
                    ok: false,
                    status: 429,
                    statusText: "Too Many Requests"
                })
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
                });

            const startTime = Date.now();
            const result = await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy"
            });
            const elapsed = Date.now() - startTime;

            expect(result).toBe("mock-signature-123");
            expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
            // Should have waited at least 300ms for backoff
            expect(elapsed).toBeGreaterThanOrEqual(300);
        });

        it("should handle 5xx server error and retry", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            
            // Mock first call to return 500, second to succeed
            fetchWithTimeout
                .mockResolvedValueOnce({
                    ok: false,
                    status: 500,
                    statusText: "Internal Server Error",
                    text: jest.fn().mockResolvedValue("Server error details")
                })
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
                });

            const result = await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy"
            });

            expect(result).toBe("mock-signature-123");
            expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
        });

        it("should return null after failed retry attempts", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            
            // Mock both calls to fail
            fetchWithTimeout
                .mockResolvedValueOnce({
                    ok: false,
                    status: 429,
                    statusText: "Too Many Requests"
                })
                .mockResolvedValueOnce({
                    ok: false,
                    status: 429,
                    statusText: "Too Many Requests"
                });

            const result = await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy"
            });

            expect(result).toBeNull();
            expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
        });

        it("should handle transaction signing and sending errors gracefully", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            
            fetchWithTimeout.mockResolvedValue({
                ok: true,
                status: 200,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
            });

            // Mock connection.sendTransaction to throw error
            mockConnection.sendTransaction = jest.fn().mockRejectedValue(new Error("Network error"));

            const result = await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy"
            });

            expect(result).toBeNull();
        });

        it("should use dynamic priority fee when none provided", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            const { calcPriorityFeeSOL } = require("../../src/utils/priorityFee.js");
            
            fetchWithTimeout.mockResolvedValue({
                ok: true,
                status: 200,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
            });

            await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy"
            });

            expect(calcPriorityFeeSOL).toHaveBeenCalledWith(mockConnection, 1_200_000, 0.90);
            expect(fetchWithTimeout).toHaveBeenCalledWith(
                "https://pumpportal.fun/api/trade-local",
                expect.objectContaining({
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    timeoutMs: 1800,
                    body: expect.stringContaining('"priorityFee":0.001')
                })
            );
        });

        it("should use provided priority fee when specified", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            
            fetchWithTimeout.mockResolvedValue({
                ok: true,
                status: 200,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(100))
            });

            await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy",
                priorityFee: 0.005
            });

            expect(fetchWithTimeout).toHaveBeenCalledWith(
                "https://pumpportal.fun/api/trade-local",
                expect.objectContaining({
                    body: expect.stringContaining('"priorityFee":0.005')
                })
            );
        });

        it("should handle non-retryable errors (4xx except 429) correctly", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            
            // Mock 400 error (non-retryable)
            fetchWithTimeout.mockResolvedValue({
                ok: false,
                status: 400,
                statusText: "Bad Request",
                text: jest.fn().mockResolvedValue("Invalid parameters")
            });

            const result = await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy"
            });

            expect(result).toBeNull();
            // Should not retry for 400 errors
            expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
        });

        it("should handle timeout scenarios", async () => {
            const { fetchWithTimeout } = require("../../src/utils/withTimeout.js");
            
            // Mock timeout error
            fetchWithTimeout.mockRejectedValue(new Error("operation timed out after 1800ms"));

            const result = await sendPumpTrade({
                connection: mockConnection,
                wallet: mockWallet,
                mint: mockMint,
                amount: 0.1,
                action: "buy"
            });

            expect(result).toBeNull();
            expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
        });
    });
});