// calls/flowExecutor.js
const { functionRegistry } = require("./functionRegistry");
const { getValueByPath, evaluateCondition } = require("./utils");
const { NodeVM } = require("vm2");
const logger = require("../../../utils/logger");

/**
 * Execute flow for a function call
 * Works for both incoming and outgoing calls
 */
async function executeFlowForFunction(
  callId,
  functionName,
  initialArgs,
  callState,
) {
  const { flowData } = callState;

  const matchedFunction = callState.flowConfig.available_functions?.find(
    (func) => func.name.replace(/\s+/g, "_").toLowerCase() === functionName,
  );

  if (!matchedFunction) {
    return "Function not found in configuration";
  }

  const startingEdge = flowData.edges.find(
    (edge) =>
      edge.source === "1" &&
      edge.sourceHandle === `function-${matchedFunction.id}`,
  );

  if (!startingEdge) {
    return "No flow connected for this function";
  }

  let currentNodeId = startingEdge.target;
  let params = initialArgs;
  const previousResponses = [];
  let lastResult = null;

  while (currentNodeId) {
    const currentNode = flowData.nodes.find(
      (node) => node.id === currentNodeId,
    );

    if (!currentNode) break;

    const nodeParams = {
      currentNode: currentNode?.data || currentNode,
      paramsValue: { ...params },
      previousResponses: [...previousResponses],
      ai: { ...initialArgs },
    };

    let nodeResponse;
    let nextEdge;

    try {
      switch (currentNode.type) {
        case "executeJs":
          nodeResponse = await executeJsNode(nodeParams, callId);
          nextEdge = flowData.edges.find(
            (edge) => edge.source === currentNodeId,
          );
          break;

        case "hangupCall": {
          const finalMessage = currentNode.data?.finalMessage || "";
          nodeResponse = {
            instruct: "Call hangup requested",
            data: {
              hangup: true,
              finalMessage: finalMessage,
              message: finalMessage || "Goodbye!",
            },
          };
          nextEdge = null;
          break;
        }

        case "apiCall":
          nodeResponse = await functionRegistry.api_call(nodeParams);
          nextEdge = flowData.edges.find(
            (edge) => edge.source === currentNodeId,
          );
          break;

        case "sendMessage":
          nodeResponse = await functionRegistry.send_message(nodeParams);
          nextEdge = flowData.edges.find(
            (edge) => edge.source === currentNodeId,
          );
          break;

        case "sendWhatsapp":
          nodeResponse = await functionRegistry.send_whatsapp(nodeParams);
          nextEdge = flowData.edges.find(
            (edge) => edge.source === currentNodeId,
          );
          break;

        case "sendSmtpEmail":
          nodeResponse = await functionRegistry.send_smtp_email(nodeParams);
          nextEdge = flowData.edges.find(
            (edge) => edge.source === currentNodeId,
          );
          break;

        case "googleServices":
          nodeResponse = await functionRegistry.google_services(nodeParams);
          nextEdge = flowData.edges.find(
            (edge) => edge.source === currentNodeId,
          );
          break;

        case "mysqlQuery":
          nodeResponse = await functionRegistry.mysql_query(nodeParams);
          nextEdge = flowData.edges.find(
            (edge) => edge.source === currentNodeId,
          );
          break;

        case "conditional": {
          const conditionResult = evaluateConditionalNode(
            currentNode,
            nodeParams,
            flowData,
          );
          nodeResponse = conditionResult.response;
          nextEdge = conditionResult.nextEdge;
          break;
        }

        default:
          logger.log(`[${callId}] Unsupported node type: ${currentNode.type}`);
          nodeResponse = {
            instruct: "Unsupported node type",
            data: { error: `Unsupported node type: ${currentNode.type}` },
          };
          nextEdge = flowData.edges.find(
            (edge) => edge.source === currentNodeId,
          );
          break;
      }
    } catch (nodeError) {
      logger.error(`[${callId}] Node error:`, nodeError);
      nodeResponse = {
        instruct: "Node execution failed",
        data: { error: nodeError.message },
      };
      nextEdge = flowData.edges.find((edge) => edge.source === currentNodeId);
    }

    if (nodeResponse?.data) {
      previousResponses.push(nodeResponse.data);
      lastResult = nodeResponse.data;
    }

    if (!nextEdge) break;

    if (nodeResponse?.data) {
      params = nodeResponse.data || {};
    }

    currentNodeId = nextEdge.target;
  }

  if (lastResult === null || lastResult === undefined) {
    return "Function executed successfully";
  }

  return lastResult;
}

/**
 * Execute JavaScript node
 */
async function executeJsNode(nodeParams, callId) {
  try {
    const code = nodeParams.currentNode.jsCode || "";
    const previousResponse =
      nodeParams.previousResponses[nodeParams.previousResponses.length - 1] ||
      null;

    // Hoist fetch fallback — avoids inline require inside sandbox
    const fetchImpl = global.fetch ?? require("node-fetch");

    const vm = new NodeVM({
      timeout: 30000,
      console: "redirect",
      sandbox: {
        response: previousResponse,
        allResponses: nodeParams.previousResponses || [],
        params: nodeParams.paramsValue || {},
        ai: nodeParams.ai || {},
        functionArgs: nodeParams.ai || {},
        fetch: fetchImpl,
      },
      require: {
        external: true,
        builtin: ["url", "querystring"],
      },
      eval: false,
      wasm: false,
    });

    const logs = [];

    vm.on("logger.log", (...args) => {
      const message = args
        .map((arg) =>
          typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg),
        )
        .join(" ");
      logs.push(message);
      logger.log(`[${callId}] JS Log:`, message);
    });

    const result = await vm.run(`
      module.exports = (async () => {
        ${code}
      })();
    `);

    return {
      instruct: "JavaScript executed successfully",
      data: result !== undefined ? result : { logs },
    };
  } catch (error) {
    logger.error(`[${callId}] JS execution error:`, error);
    return {
      instruct: "JavaScript execution failed",
      data: { error: error.message, logs: [] },
    };
  }
}

/**
 * Evaluate conditional node
 */
function evaluateConditionalNode(currentNode, nodeParams, flowData) {
  const pathToEvaluate = currentNode.data.variableName;
  let valueToEvaluate = getValueByPath(nodeParams, pathToEvaluate);

  valueToEvaluate =
    valueToEvaluate !== undefined && valueToEvaluate !== null
      ? String(valueToEvaluate)
      : valueToEvaluate;

  let matchedCondition = null;
  for (const condition of currentNode.data.conditions || []) {
    if (condition.type === "default" || !condition.type) {
      continue;
    }
    const isMatch = evaluateCondition(valueToEvaluate, condition);
    if (isMatch) {
      matchedCondition = condition;
      break;
    }
  }

  if (!matchedCondition) {
    matchedCondition = currentNode.data.conditions.find(
      (c) => c.type === "default",
    );
  }

  const nextEdge = flowData.edges.find(
    (edge) =>
      edge.source === currentNode.id &&
      edge.sourceHandle === `condition-${matchedCondition?.id}`,
  );

  return {
    response: {
      instruct: "Condition evaluated",
      data: {
        condition: matchedCondition?.name || "Unknown",
        value: valueToEvaluate,
      },
    },
    nextEdge,
  };
}

/**
 * Build tools from flow configuration
 */
function buildToolsFromFlow(flowConfig) {
  const tools = [];

  if (
    flowConfig.available_functions &&
    Array.isArray(flowConfig.available_functions)
  ) {
    flowConfig.available_functions.forEach((func) => {
      const tool = {
        type: "function",
        name: func.name.replace(/\s+/g, "_").toLowerCase(),
        description: func.description || `Execute ${func.name}`,
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      };

      if (func.parameters && Array.isArray(func.parameters)) {
        func.parameters.forEach((param) => {
          tool.parameters.properties[param.name] = {
            type: param.type || "string",
            description: param.description || "",
          };
          if (param.required) {
            tool.parameters.required.push(param.name);
          }
        });
      }

      tools.push(tool);
    });
  }

  return tools;
}

module.exports = {
  executeFlowForFunction,
  executeJsNode,
  evaluateConditionalNode,
  buildToolsFromFlow,
};
