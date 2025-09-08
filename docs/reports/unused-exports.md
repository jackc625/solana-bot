[93m[4mUnused files[24m[39m (29)
scripts/quickMetricsTest.ts                                 
scripts/simpleMetricsTest.js                                
scripts/testLpLockReal.ts                                   
scripts/testLpLockSimple.cjs                                
scripts/testMetrics.ts                                      
scripts/testPortfolioRisk.ts                                
scripts/testPositionPersistence.ts                          
scripts/testRpcFailover.ts                                  
src/utils/getLpLiquidity.ts                                 
src/utils/getLpTokenAddress.ts                              
src/utils/index.ts                                          
src/utils/testLiquidityAnalysis.ts                          
src/utils/testSocialVerification.ts                         
test/integration/lpLockRealWorldTest.ts                     
tests/integration/lpLockRealWorldTest.ts                    
src/core/clients/index.ts                                   
src/core/clients/splTokenCompat.ts                          
src/core/portfolio/index.ts                                 
src/core/state/index.ts                                     
src/features/autosell/index.ts                              
src/features/discovery/index.ts                             
src/features/discovery/pendingTokens.ts                     
src/features/discovery/pumpPortalSocket.ts                  
src/features/mev/index.ts                                   
src/features/validation/index.ts                            
src/features/telemetry/index.ts                             
src/features/safety/stageAwareSafety/checks/authorities.ts  
src/features/safety/stageAwareSafety/checks/route.ts        
src/features/safety/stageAwareSafety/stages/preBond.ts      
[93m[4mUnused dependencies[24m[39m (5)
@jup-ag/api                              package.json:54:6
@metaplex-foundation/mpl-token-metadata  package.json:56:6
node-telegram-bot-api                    package.json:63:6
rpc-websockets                           package.json:66:6
socket.io-client                         package.json:67:6
[93m[4mUnused devDependencies[24m[39m (7)
@types/bn.js                  package.json:29:6
@types/bs58                   package.json:30:6
@types/node-fetch             package.json:33:6
@types/node-telegram-bot-api  package.json:34:6
@types/p-queue                package.json:35:6
jest-environment-node         package.json:44:6
tsx                           package.json:50:6
[93m[4mUnresolved imports[24m[39m (3)
@typescript-eslint/eslint-config-recommended  .eslintrc.json                           
../src/utils/lpLockVerification.js            tests/unit/lpLockVerification.test.ts:4:9
../src/core/scoring.js                        tests/unit/marketCap.test.ts:57:8        
[93m[4mUnused exports[24m[39m (34)
rpcManager                           src/utils/rpcManager.ts:480:14                               
positionPersistence                  src/utils/positionPersistence.ts:607:14                      
metricsCollector                     src/utils/metricsCollector.ts:601:14                         
default                    class     src/utils/metricsServer.ts:362:8                             
logTrade                   function  src/utils/logger.ts:270:23                                   
logError                   function  src/utils/logger.ts:274:23                                   
transactionPrep                      src/utils/transactionPreparation.ts:301:14                   
StateMachineCoordinator    class     src/state/stateMachineCoordinator.ts:16:14                   
default                              src/state/stateMachineCoordinator.ts:468:8                   
default                              src/state/tokenStateMachine.ts:571:8                         
DEFAULT_PIPELINE_CONFIG              src/core/stageAwarePipeline.ts:19:14                         
StageAwarePipeline         class     src/core/stageAwarePipeline.ts:27:14                         
detectAmmType              function  src/utils/lpLockVerification.ts:310:17                       
default                              src/utils/lpLockVerification.ts:363:8                        
DEFAULT_TIP_AMOUNTS                  src/utils/jitoBundle.ts:509:9                                
JITO_BLOCK_ENGINES                   src/utils/jitoBundle.ts:509:30                               
sendPumpTrade              function  src/utils/mevAwarePumpTrade.ts:289:23                        
dualExecutionStrategy                src/core/dualExecutionStrategy.ts:711:14                     
emergencyCircuitBreaker              src/core/emergencyCircuitBreaker.ts:198:14                   
startRetryValidator                  src/features/validation/retryValidator.ts:33:14              
bus                                  src/core/events/bus.ts:3:14                                  
liquidityAnalyzer                    src/utils/liquidityAnalysis.ts:412:14                        
socialVerificationService            src/utils/socialVerification.ts:558:14                       
CreatorAnalyzer            class     src/features/safety/stageAwareSafety/checks/creator.ts:15:14 
VelocityTracker            class     src/features/safety/stageAwareSafety/checks/velocity.ts:13:14
TokenScorer                class     src/features/safety/stageAwareSafety/checks/scoring.ts:8:14  
stageAwareSafety                     src/core/stageAwareSafety.ts:508:14                          
TokenWatchlist             class     src/features/discovery/tokenWatchlist.ts:26:14               
networkHealthMonitor                 src/utils/networkHealth.ts:206:14                            
getJupiterQuote            function  src/features/validation/jupiterHttp.ts:96:23                 
getJupiterSwap             function  src/features/validation/jupiterHttp.ts:157:23                
onChainLpAnalyzer                    src/utils/onChainLpReserves.ts:512:14                        
getOnChainLpReserves       function  src/utils/onChainLpReserves.ts:517:23                        
default                              src/utils/onChainLpReserves.ts:543:8                         
[93m[4mUnused exported types[24m[39m (50)
RpcHealthMetrics              interface  src/utils/rpcManager.ts:8:18                       
RpcStatus                     interface  src/utils/rpcManager.ts:20:18                      
SafetyResult                  interface  src/core/safety.ts:42:18                           
ScoreResult                   interface  src/core/scoring.ts:16:18                          
PersistedPosition             interface  src/utils/positionPersistence.ts:12:18             
DeployerExposureData          interface  src/utils/positionPersistence.ts:37:18             
PortfolioRiskState            interface  src/utils/positionPersistence.ts:45:18             
PersistedState                interface  src/utils/positionPersistence.ts:50:18             
PositionReconciliationResult  interface  src/utils/positionPersistence.ts:64:18             
DeployerExposure              interface  src/core/portfolioRiskManager.ts:9:18              
TokenPosition                 interface  src/core/portfolioRiskManager.ts:17:18             
PortfolioRiskResult           interface  src/core/portfolioRiskManager.ts:25:18             
PortfolioRiskState            interface  src/core/portfolioRiskManager.ts:35:18             
TradingOperation              type       src/utils/metricsCollector.ts:14:13                
TradingOutcome                type       src/utils/metricsCollector.ts:19:13                
SystemComponent               type       src/utils/metricsCollector.ts:24:13                
MetricsServerConfig           interface  src/utils/metricsServer.ts:9:18                    
EnvironmentValidationResult   interface  src/utils/validateEnvironment.ts:7:18              
LogLevel                      enum       src/utils/logger.ts:4:13                           
LogEntry                      interface  src/utils/logger.ts:11:18                          
StateTransitionResult         interface  src/state/tokenStateMachine.ts:134:18              
StageAwarePipelineConfig      interface  src/core/stageAwarePipeline.ts:11:18               
StageMetrics                  interface  src/utils/stageAwareMetrics.ts:8:18                
PipelineMetrics               interface  src/utils/stageAwareMetrics.ts:17:18               
MEVProtectionResult           interface  src/core/mevProtection.ts:27:18                    
MEVProtectedTradeExecution    interface  src/core/mevProtection.ts:44:18                    
JitoBundleConfig              interface  src/utils/jitoBundle.ts:48:18                      
BundleStatus                  interface  src/utils/jitoBundle.ts:67:18                      
SandwichIndicator             interface  src/utils/sandwichDetection.ts:25:18               
MempoolAnalysis               interface  src/utils/sandwichDetection.ts:41:18               
MEVAwarePumpTradeParams       interface  src/utils/mevAwarePumpTrade.ts:18:18               
MEVAwarePumpTradeResult       interface  src/utils/mevAwarePumpTrade.ts:35:18               
ExecutionMethod               enum       src/core/dualExecutionStrategy.ts:29:13            
DualExecutionConfig           interface  src/core/dualExecutionStrategy.ts:35:18            
ExecutionResult               interface  src/core/dualExecutionStrategy.ts:52:18            
TradeParams                   interface  src/core/dualExecutionStrategy.ts:84:18            
TradeParams                   interface  src/features/execution/types.ts:3:18               
TradeResult                   interface  src/features/execution/types.ts:17:18              
ITradeExecutor                interface  src/features/execution/types.ts:24:18              
ExecutionMethod               enum       src/features/execution/types.ts:54:13              
RiskLevel                     enum       src/features/execution/types.ts:60:13              
DomainEvent                   type       src/core/events/bus.ts:5:13                        
SocialVerificationResult      interface  src/utils/socialVerification.ts:8:18               
TokenSocialData               interface  src/utils/socialVerification.ts:27:18              
WatchlistStats                interface  src/features/discovery/tokenWatchlist.ts:18:18     
OnChainLpData                 interface  src/utils/onChainLpReserves.ts:34:18               
LpPoolSearchResult            interface  src/utils/onChainLpReserves.ts:61:18               
PoolDetectionResult           interface  src/utils/poolDetection.ts:12:18                   
SafetyContext                 interface  src/features/safety/stageAwareSafety/index.ts:7:18 
SafetyReport                  interface  src/features/safety/stageAwareSafety/index.ts:13:18
[93m[4mDuplicate exports[24m[39m (14)
rpcManager|default                 src/utils/rpcManager.ts                  
positionPersistence|default        src/utils/positionPersistence.ts         
portfolioRiskManager|default       src/core/portfolioRiskManager.ts         
metricsCollector|default           src/utils/metricsCollector.ts            
transactionPrep|default            src/utils/transactionPreparation.ts      
stateMachineCoordinator|default    src/state/stateMachineCoordinator.ts     
tokenStateMachine|default          src/state/tokenStateMachine.ts           
dualExecutionStrategy|default      src/core/dualExecutionStrategy.ts        
emergencyCircuitBreaker|default    src/core/emergencyCircuitBreaker.ts      
startRetryValidator|default        src/features/validation/retryValidator.ts
liquidityAnalyzer|default          src/utils/liquidityAnalysis.ts           
socialVerificationService|default  src/utils/socialVerification.ts          
networkHealthMonitor|default       src/utils/networkHealth.ts               
onChainLpAnalyzer|default          src/utils/onChainLpReserves.ts           
[33m[4mConfiguration hints[24m (2)[39m
.                         [90mCreate [97mknip.json[90m configuration file with [97mworkspaces["."][90m object (29 unused files)[39m
index.js    package.json  [90mPackage entry file not found[39m                                                     
