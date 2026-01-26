// Store the node the user originally selected (must be a COMPONENT or COMPONENT_SET)
let originalSelection = null;
// Timer for debouncing the selection change event
let selectionTimeout = null; 

// Show the UI
figma.showUI(__html__, {
  width: 340,
  height: 480,
  title: "Variant Layer Selector"
});

// --- Helper Functions ---

/**
 * Finds the relevant Component or ComponentSet node from the user's selection.
 */
async function findComponentSet(node) {
  if (!node) return null;

  // Selected a Component Set directly
  if (node.type === 'COMPONENT_SET') return node;

  // Selected a Component within a Set
  if (node.type === 'COMPONENT' && node.parent && node.parent.type === 'COMPONENT_SET') {
    return node.parent;
  }

  // Selected a standalone Component
  if (node.type === 'COMPONENT') return node;

  return null;
}

/**
 * Recursively traverses a node and returns a flat list of all its children,
 * including their full name path (e.g., "Group/Icon") and structural path (e.g., "0/1/").
 */
function getLayers(node) {
  const layerList = [];

  function traverse(childNode, namePrefix, indexPath) {
    // 'name' is the full path, e.g., "Group/Icon"
    const displayName = namePrefix + childNode.name;
    // 'path' is the structural index path, e.g., "0/1/"
    const structuralPath = indexPath;

    layerList.push({ name: displayName, id: childNode.id, path: structuralPath });

    if ('children' in childNode && childNode.children.length) {
      childNode.children.forEach((grandChild, index) => {
        traverse(grandChild, displayName + '/', structuralPath + index + '/');
      });
    }
  }

  if ('children' in node && node.children.length) {
    node.children.forEach((child, index) => {
      traverse(child, '', index + '/');
    });
  }

  return layerList;
}

/**
 * Special handler for when the user selects a single, standalone component.
 */
function buildGroupsForSingleComponent(componentNode) {
  const layers = getLayers(componentNode);
  const layerMap = new Map();

  for (const layer of layers) {
    // We group by 'layer.name' (the full name path) to ensure
    // that "Group/Icon" is treated as one layer.
    const key = layer.path;
    if (!layerMap.has(key)) {
      layerMap.set(key, { name: layer.name, path: layer.path, nodeIds: [] });
    }
    layerMap.get(key).nodeIds.push(layer.id);
  }

  return [
    {
      propertyName: 'Component Layers',
      options: [
        {
          value: componentNode.name || 'Component',
          uniqueLayers: Array.from(layerMap.values())
        }
      ]
    }
  ];
}

/**
 * Main function to process the user's selection and build the layer groups.
 */
async function processSelection() {
  const selection = figma.currentPage.selection;

  // --- 1. Handle Empty Selection ---
  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'no-selection', message: 'Please select a component, component set, or instance.' });
    originalSelection = null;
    return;
  }

  let targetNode = selection[0];

  // --- 2. Sanitize Selection ---
  // If an instance is selected, find its main component
  if (targetNode.type === 'INSTANCE') {
    if (targetNode.mainComponent) {
      targetNode = targetNode.mainComponent;
    } else {
      figma.ui.postMessage({ type: 'no-selection', message: 'Selected instance has no main component.' });
      originalSelection = null;
      return;
    }
  }

  // If a container (Frame, Group) is selected, try to find a component inside
  if (['FRAME', 'GROUP', 'SECTION'].includes(targetNode.type)) {
    const validDescendant = targetNode.findOne(n => n.type === 'COMPONENT' || n.type === 'INSTANCE');
    if (validDescendant) {
      targetNode = validDescendant.type === 'INSTANCE' && validDescendant.mainComponent
        ? validDescendant.mainComponent
        : validDescendant;
    } else {
      figma.ui.postMessage({ type: 'no-selection', message: 'Selected container has no component inside.' });
      originalSelection = null;
      return;
    }
  }

  // Store the node we're analyzing
  originalSelection = targetNode;

  // Find the Component or ComponentSet
  const componentOrSet = await findComponentSet(originalSelection);
  if (!componentOrSet) {
    figma.ui.postMessage({ type: 'no-selection', message: 'Selected node is not a component or component set.' });
    originalSelection = null;
    return;
  }

  // --- 3. Handle Standalone Component ---
  if (componentOrSet.type === 'COMPONENT') {
    const groupsData = buildGroupsForSingleComponent(componentOrSet);
    figma.ui.postMessage({ type: 'load-groups', data: groupsData });
    return;
  }

  // --- 4. Handle Component Set (Variants) ---
  const definitions = componentOrSet.componentPropertyDefinitions || {};
  const variants = componentOrSet.children.filter(n => n.type === 'COMPONENT');
  const groupsData = [];

  // Loop through each property (e.g., "State", "Icon")
  for (const propName in definitions) {
    const propDefinition = definitions[propName];

    let options = [];
    if (propDefinition.type === 'VARIANT') {
      options = propDefinition.variantOptions;
    } else if (propDefinition.type === 'BOOLEAN') {
      options = ['True', 'False'];
    } else {
      continue; // Skip other property types
    }

    const propertyGroup = { propertyName: propName, options: [] };

    // Loop through each option (e.g., "Default", "Hover")
    for (const optionValue of options) {
      const propertyMatcher = `${propName}=${optionValue}`;
      const matchingVariants = variants.filter(v =>
        v.name.split(', ').includes(propertyMatcher)
      );

      if (matchingVariants.length === 0) continue;

      // This map will store all unique layers for this option
      // e.g., all layers found in "State=Hover" variants
      const layerMap = new Map();
      for (const variant of matchingVariants) {
        const layers = getLayers(variant);
        for (const layer of layers) {
          
          // We use 'layer.name' (the full name path) as the key.
          // This is the core logic that:
          // 1. Groups identical layers (e.g., "Icon/BG") across variants.
          // 2. Separates different layers at the same position (e.g., "Header" and "Footer").
          const key = layer.path; 
          
          if (!layerMap.has(key)) {
            layerMap.set(key, { name: layer.name, path: layer.path, nodeIds: [] });
          }
          layerMap.get(key).nodeIds.push(layer.id);
        }
      }

      propertyGroup.options.push({
        value: optionValue,
        uniqueLayers: Array.from(layerMap.values())
      });
    }

    if (propertyGroup.options.length > 0) {
      groupsData.push(propertyGroup);
    }
  }

  figma.ui.postMessage({ type: 'load-groups', data: groupsData });
}

// --- Plugin Event Listeners ---

// Run the main function once on launch
processSelection();

// Re-run the main function on selection change,
// but "debounce" it to avoid running on every single click.
figma.on('selectionchange', () => {
  // Clear any existing timer
  if (selectionTimeout) {
    clearTimeout(selectionTimeout);
  }

  // Set a new timer to run the function after 200ms
  selectionTimeout = setTimeout(async () => {
    try {
      await processSelection();
    } catch (e) {
      console.error('Error during selection processing:', e);
    }
  }, 200); 
});


/**
 * Handle messages from the UI (ui.html)
 */
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'select-layers') {
    // Check if the user's selection has changed since they loaded the plugin
    if (!originalSelection) {
      figma.notify('Your selection has changed. Please re-select a component.', { error: true });
      return;
    }

    const nodesToSelect = new Set();

    for (const id of msg.ids) {
      try {
        const node = await figma.getNodeByIdAsync(id);
        if (node) {
          nodesToSelect.add(node);
        }
      } catch (e) { 
        // ignore missing/invalid node ids
      }
    }

    const uniqueNodes = Array.from(nodesToSelect);
    figma.currentPage.selection = uniqueNodes;

    if (uniqueNodes.length > 0) {
      figma.viewport.scrollAndZoomIntoView(uniqueNodes);
    }

    figma.notify(`Selected ${uniqueNodes.length} layer${uniqueNodes.length > 1 ? 's' : ''}.`);
  }
};