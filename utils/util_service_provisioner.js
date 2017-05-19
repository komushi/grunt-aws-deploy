'use strict';

const AWS = require('aws-sdk');
const url = require('url');
const RefParser = require('json-schema-ref-parser');
const compile = require('es6-template-strings/compile');
const resolveToString = require('es6-template-strings/resolve-to-string');
const YAML = require('js-yaml');
const fs = require('fs');


/**
 * Library for service provisioning activities.
 * These functions are called by Grunt tasks but could be called by other modules as well.
 *
 * @type {ServiceProvisioner}
 */
module.exports = class ServiceProvisioner {

  /**
   * Construct new ServiceProvisioner object with supplied chracteristics
   * @param awsRegion {string} where service needs to be deployed
   * @param deployStage {string} for service to deploy to. Eg : dev, test, prod
   * @param serviceName {string} of the service
   * @param [debugMode] {boolean}
   */
  constructor(awsRegion, deployStage, serviceName, debugMode) {
    validateStringArgument(awsRegion, 'awsRegion');
    validateStringArgument(deployStage, 'deployStage');
    validateStringArgument(serviceName, 'serviceName');
    this.awsRegion = awsRegion;
    this.deployStage = deployStage;
    this.serviceName = serviceName;
    this.debugMode = debugMode;
  }

  /**
   * Setup AWS resources and import swagger spec to make an API GW based service fully functional
   * @param cfnTemplateFile {string} cloudformation template to create all the resources
   *              necessary for service
   *              The cloudformation stack needs to at least output APIID
   *              All other outputs are used as variable substitutions for swagger
   * @param config {Object} parameters for the service.
   *              These become the input parameters for cloudformation
   * @param swaggerFile containing spec for the API
   * @return {Promise} of the service setup
   */
  setupApiGwService(cfnTemplateFile, config, swaggerFile) {
    let cfnOutput = null;
    const thisObject = this;
    return thisObject.createOrUpdateStack(cfnTemplateFile, config)
      .then((cloudformationOutput) => {
        cfnOutput = cloudformationOutput;
        if (!cfnOutput.APIID) {
          throw new Error('APIID needs to be returned by cloudromation');
        }
        return ServiceProvisioner.bundleExternals(swaggerFile, null, thisObject.debugMode);
      })
      .then((bundledObject) => {
        const templateResolvedSwagger = ServiceProvisioner.getYamlWithTemplateResolution(bundledObject,
          cfnOutput);
        thisObject.debug(`Swagger being imported : ${templateResolvedSwagger}`);
        return thisObject.importRestApi(templateResolvedSwagger, cfnOutput.APIID);
      })
      .then(() => thisObject.deployRestApi(cfnOutput.APIID));
  }

  stackName() {
    return `${this.serviceName}-${this.deployStage}-backend`;
  }

  /**
   * Create or update specified stack.
   * @param cfnTemplateFile {string} cloudformation template to create all
   *        the resources necessary for service
   * @param config {Object} parameters for the service.
   *        These become the input parameters for cloudformation
   * @return {Promise}
   */
  createOrUpdateStack(cfnTemplateFile, config) {
    const cloudFormation = new AWS.CloudFormation({ apiVersion: '2010-05-15', region: this.awsRegion });
    const thisObject = this;
    const stackName = thisObject.stackName();
    return new Promise((resolve, reject) => {
      validateStringArgument(cfnTemplateFile, 'cfnTemplateFile');

      cloudFormation.describeStacks({ StackName: stackName }, (err) => {
        if (err) {
          if (err.toString().endsWith(' does not exist')) {
            thisObject.debug(`Creating new stack ${stackName}`);
            createCfnParams(stackName, thisObject.serviceName,
              cfnTemplateFile, thisObject.deployStage,
              config)
              .then((params) => {
                cloudFormation.createStack(params, (createErr) => {
                  if (createErr) {
                    thisObject.debug(`Error creating stack : ${JSON.stringify(err)}`);
                    return reject(createErr);
                  }
                  thisObject.debug('waiting for stack creation ...');
                  return waitForCreation(cloudFormation, stackName, true)
                    .then((cfnOutput) => {
                      thisObject.debug(`stack creation output : ${JSON.stringify(cfnOutput)}`);
                      resolve(cfnOutput);
                    })
                    .catch((wtErr) => {
                      thisObject.debug(`Error creating stack : ${JSON.stringify(wtErr)}`);
                      reject(wtErr);
                    });
                });
              })
              .catch((createPramErr) => {
                thisObject.debug(`Error creating stack params : ${JSON.stringify(createPramErr)}`);
                reject(createPramErr);
              });
          } else {
            thisObject.debug(`Error creating stack : ${JSON.stringify(err)}`);
            reject(err);
          }
        } else {
          thisObject.debug(`Updating stack ${stackName}`);
          createCfnParams(stackName, thisObject.serviceName,
            cfnTemplateFile, thisObject.deployStage,
            config)
            .then((params) => {
              cloudFormation.updateStack(params, (updateErr) => {
                if (updateErr) {
                  thisObject.debug(`Error updating stack : ${JSON.stringify(updateErr)}`);
                  return reject(updateErr);
                }
                thisObject.debug('waiting for stack update ...');
                return waitForCreation(cloudFormation, stackName, false)
                  .then((cfnOutput) => {
                    thisObject.debug(`stack update output : ${JSON.stringify(cfnOutput)}`);
                    resolve(cfnOutput);
                  })
                  .catch((waitForErr) => {
                    thisObject.debug(`Error updating stack : ${JSON.stringify(waitForErr)}`);
                    reject(waitForErr);
                  });
              });
            })
            .catch((createCfnParamsErr) => {
              thisObject.debug(`Error creating stack params : ${JSON.stringify(createCfnParamsErr)}`);
              reject(createCfnParamsErr);
            });
        }
      });
    });
  }

  /**
   * Bundle all the external references of YAML into single file
   * @param parentSwaggerFile the topmost swagger file
   * @param options
   * @param debugMode
   * @returns {*|Request|Promise} of bundled object with all externals inlined
   */
  static bundleExternals(parentSwaggerFile, options, debugMode) {
    const parser = new RefParser();
    return parser.resolve(parentSwaggerFile, options)
      .then(refs => new Promise((resolve) => {
        globalDebug(debugMode, `Bundling ref pointers in ${refs._root$Ref.path}`);
          // Build an inventory of all ref pointers in the JSON Schema
        const inventory = [];

          // Recursively crawl through schema to build inventory
        crawl(parser, 'schema', `${refs._root$Ref.path}#`, '#', inventory, refs, options);

          // Remap external ref pointers
        remapExternals(inventory, debugMode);

        resolve(parser.schema);
      }));
  }

  /**
   * Import Rest swaggerText spec specified into supplied API ID
   * @param swaggerText
   * @param apiId
   * @param mode
   * @return {Promise}
   */
  importRestApi(swaggerText, apiId, mode) {
    const apiGateway = new AWS.APIGateway({ apiVersion: '2015-07-09', region: this.awsRegion });
    const thisObject = this;
    return new Promise((resolve, reject) => {
      const params = {
        body: new Buffer(swaggerText),
        restApiId: apiId,
        failOnWarnings: true,
        mode
      };

      thisObject.debug(`Importing rest API for id : ${apiId}`);

      // Import the file into swaggerText
      apiGateway.putRestApi(params, (err, data) => {
        if (err) {
          reject(err);
        } else {
          thisObject.debug('Rest API import completed successfully : ');
          thisObject.debug(JSON.stringify(data));
          resolve(data);
        }
      });
    });
  }


  /**
   * Deploy API with supplied ID
   * @param apiId
   */
  deployRestApi(apiId) {
    const apiGateway = new AWS.APIGateway({ apiVersion: '2015-07-09', region: this.awsRegion });
    const thisObject = this;
    return new Promise((resolve, reject) => {
      const params = {
        restApiId: apiId,
        stageName: this.deployStage,
      };
      thisObject.debug(`Deploying rest API for id : ${apiId}, env ${this.deployStage}`);

      // Finally import the file into swagger
      apiGateway.createDeployment(params, (err, data) => {
        if (err) {
          reject(err);
        } else {
          thisObject.debug('Deployed API successfully : ');
          thisObject.debug(JSON.stringify(data));
          data.APIID = apiId;
          resolve(data);
        }
      });
    });
  }

  /**
   * Get YAML corresponding to the input object and then perform variable substitution on the YAML
   * @param inputObject
   * @param templateResolveParams
   * @return templateResolvedYAML
   */
  static getYamlWithTemplateResolution(inputObject, templateResolveParams) {
    const yamlText = YAML.dump(inputObject, { noRefs: true });
    const compiledYamlText = compile(yamlText);
    return resolveToString(compiledYamlText, templateResolveParams);
  }


  /**
   * Delete AWS stack associated with the service
   * @return {Promise}
   */
  deleteStack() {
    const cloudFormation = new AWS.CloudFormation({ apiVersion: '2010-05-15', region: this.awsRegion });
    const stackName = this.stackName();
    const thisObject = this;
    return new Promise((resolve, reject) => {
      cloudFormation.deleteStack({ StackName: stackName }, (err, data) => {
        if (err) {
          thisObject.debug(`Error deleting stack : ${JSON.stringify(err)}`);
          reject(err);
        } else {
          thisObject.debug(`Delete Stack Start output : ${JSON.stringify(data)}`);
          waitForDeletion(cloudFormation, stackName)
            .then((deleteStackData) => {
              thisObject.debug(`Delete Stack output : ${JSON.stringify(deleteStackData)}`);
              resolve(deleteStackData);
            })
            .catch((waitForErr) => {
              thisObject.debug(`Error deleting stack : ${JSON.stringify(waitForErr)}`);
              reject(waitForErr);
            });
        }
      });
    });
  }

  /**
   * Debug statements
   * @param debugString
   */
  debug(debugString) {
    globalDebug(this.debugMode, debugString);
  }
};

function globalDebug(debugMode, debugString) {
  if (debugMode) {
    console.log(debugString);
  }
}

function validateStringArgument(stringArgument, argumentName) {
  if (!stringArgument) {
    throw new Error(`${argumentName} is required`);
  }
  if (typeof stringArgument !== 'string') {
    throw new Error(`${argumentName} should be a string`);
  }
}

/**
 * Creates a JSON pointer path, by joining one or more tokens to a base path.
 *
 * @param {string} base - The base path (e.g. "schema.json#/definitions/person")
 * @param {string|string[]} tokens - The token(s) to append (e.g. ["name", "first"])
 * @returns {string}
 */
function jSONPointerPath(base, tokens) {
  const slashes = /\//g;
  const tildes = /~/g;

  // Ensure that the base path contains a hash
  if (base.indexOf('#') === -1) {
    base += '#';
  }

  // Append each token to the base path
  tokens = Array.isArray(tokens) ? tokens : [tokens];
  tokens.forEach((token) => {
    // Encode the token, according to RFC 6901
    base += `/${encodeURI(token.replace(tildes, '~0').replace(slashes, '~1'))}`;
  });
  return base;
}

/**
 * Returns the hash (URL fragment), of the given path.
 * If there is no hash, then the root hash ("#") is returned.
 *
 * @param   {string} path
 * @returns {string}
 */
function getHash(path) {
  const hashIndex = path.indexOf('#');
  if (hashIndex >= 0) {
    return path.substr(hashIndex);
  }
  return '#';
}

/**
 * Removes the hash (URL fragment), if any, from the given path.
 *
 * @param   {string} path
 * @returns {string}
 */
function stripHash(path) {
  const hashIndex = path.indexOf('#');
  if (hashIndex >= 0) {
    path = path.substr(0, hashIndex);
  }
  return path;
}

/**
 * Determines whether the given value is a JSON reference.
 *
 * @param {*} value - The value to inspect
 * @returns {boolean}
 */
function isRef(value) {
  return value && typeof value === 'object' && typeof value.$ref === 'string' && value.$ref.length > 0;
}

function isExternalRef(value) {
  return value.$ref[0] !== '#';
}

/**
 * Remap all external references to their resolved content.
 * @param inventory
 * @param debugMode
 */
function remapExternals(inventory, debugMode) {
  inventory.forEach((inventoryItem) => {
    if (inventoryItem.externalFileRef) { // only remap external references
      globalDebug(debugMode, `Re-mapping ref pointer ${inventoryItem.ref.$ref} at ${inventoryItem.pathFromRoot}`);
      // dereference new path
      inventoryItem.ref = inventoryItem.value;
      inventoryItem.parent[inventoryItem.key] = inventoryItem.value;

      if (inventoryItem.circular) {
        // This ref points to itself
        inventoryItem.ref.$ref = inventoryItem.pathFromRoot;
      }

      globalDebug(debugMode, `    new value: ${(inventoryItem.ref && inventoryItem.ref.$ref) ? inventoryItem.ref.$ref : '[object Object]'}`);
    }
  });
}

/**
 * Recursively crawls the given value, and inventories all JSON references.
 *
 * @param {object} parent - The object containing the value to crawl.
 *          If the value is not an object or array, it will be ignored.
 * @param {string} key - The property key of `parent` to be crawled
 * @param {string} path - The full path of the property being crawled,
 *          possibly with a JSON Pointer in the hash
 * @param {string} pathFromRoot - The path of the property being crawled, from the schema root
 * @param {object[]} inventory - An array of already-inventoried ref pointers
 * @param {refs} refs
 * @param {$RefParserOptions} options
 */
function crawl(parent, key, path, pathFromRoot, inventory, refs, options) {
  const obj = key === null ? parent : parent[key];

  if (obj && typeof obj === 'object') {
    if (isRef(obj)) {
      inventoryRef(parent, key, path, pathFromRoot, inventory, refs, options);
    } else {
      const keys = Object.keys(obj);

      // Most people will expect references to be bundled into the the "definitions" property,
      // so we always crawl that property first, if it exists.
      const defs = keys.indexOf('definitions');
      if (defs > 0) {
        keys.splice(0, 0, keys.splice(defs, 1)[0]);
      }

      keys.forEach((thisKey) => {
        const keyPath = jSONPointerPath(path, thisKey);
        const keyPathFromRoot = jSONPointerPath(pathFromRoot, thisKey);
        const value = obj[thisKey];

        if (isRef(value)) {
          inventoryRef(obj, thisKey, path, keyPathFromRoot, inventory, refs, options);
        } else {
          crawl(obj, thisKey, keyPath, keyPathFromRoot, inventory, refs, options);
        }
      });
    }
  }
}

/**
 * Inventories the given JSON Reference (i.e. records detailed information about it so we can
 * optimize all refs in the schema), and then crawls the resolved value.
 *
 * @param {object} refParent - The object that contains a JSON Reference as one of its keys
 * @param {string} refKey - The key in `refParent` that is a JSON Reference
 * @param {string} path - The full path of the JSON Reference at `refKey`,
 *                  possibly with a JSON Pointer in the hash
 * @param {string} pathFromRoot - The path of the JSON Reference at `refKey`, from the schema root
 * @param {object[]} inventory - An array of already-inventoried ref pointers
 * @param {refs} refs
 * @param {$RefParserOptions} options
 */
function inventoryRef(refParent, refKey, path, pathFromRoot, inventory, refs, options) {
  if (inventory.some(i => i.parent === refParent && i.key === refKey)) {
    // This $Ref has already been inventoried, so we don't need to process it again
    return;
  }

  const ref = refKey === null ? refParent : refParent[refKey];
  const refPath = url.resolve(path, ref.$ref);
  const pointer = refs._resolve(refPath, options);
  const file = stripHash(pointer.path);
  const hash = getHash(pointer.path);
  const external = file !== refs._root$Ref.path;
  const externalFileRef = isExternalRef(refParent[refKey]);

  inventory.push({
    ref,                // The JSON Reference (e.g. {ref: string})
    parent: refParent,  // The object that contains this ref pointer
    key: refKey,        // The key in `parent` that is the ref pointer
    pathFromRoot,       // The path to the ref pointer, from the JSON Schema root
    file,               // The file that the ref pointer resolves to
    hash,               // The hash within `file` that the ref pointer resolves to
    value: pointer.value,  // The resolved value of the ref pointer
    circular: pointer.circular, // Is this ref pointer DIRECTLY circular?
                                // (i.e. it references itself)
    external,           // Does this ref pointer point to a file other than the main  file?
    externalFileRef     // Is this ref referencing an external file?
  });

  // Recursively crawl the resolved value
  crawl(pointer.value, null, pointer.path, pathFromRoot, inventory, refs, options);
}


/**
 * Wait for creation of update of cloudformation stack of the service
 * @param cloudFormation
 * @param stackName
 * @param createFlag indicating weather to wait for creation or update
 * @return {Promise} of cloudformation output
 */
function waitForCreation(cloudFormation, stackName, createFlag) {
  return new Promise((resolve, reject) => {
    let waitForState;
    if (createFlag) {
      waitForState = 'stackCreateComplete';
    } else {
      waitForState = 'stackUpdateComplete';
    }
    cloudFormation.waitFor(waitForState, { StackName: stackName }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        const cfnOutput = {};
        if (data.Stacks && data.Stacks.length > 0) {
          if (data.Stacks[0].Outputs) {
            // Map cfn output to cfnOutput object
            data.Stacks[0].Outputs.forEach((output) => {
              cfnOutput[output.OutputKey] = output.OutputValue;
            });
          }
        }
        resolve(cfnOutput);
      }
    });
  });
}

/**
 * Wait for deletion of cloudformation stack of the service
 * @param cloudFormation
 * @param stackName
 * @return {Promise} of cloudformation deletion output
 */
function waitForDeletion(cloudFormation, stackName) {
  return new Promise((resolve, reject) => {
    cloudFormation.waitFor('stackDeleteComplete', { StackName: stackName }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  }
  );
}

function createCfnParams(stackName, serviceName, templateFile, deployStage, config) {
  config = config || {};
  return new Promise((resolve, reject) => {
    fs.readFile(templateFile, 'utf8', (err, data) => {
      if (err) {
        return reject(err);
      }
      const params = {
        StackName: stackName,
        TemplateBody: data,
        Capabilities: ['CAPABILITY_IAM']
      };

      // map config values into cfn parameters
      params.Parameters = Object.keys(config)
        .map(key => ({
          ParameterKey: key,
          ParameterValue: config[key]
        }));
      params.Parameters.push({ ParameterKey: 'DeployStage', ParameterValue: deployStage });
      params.Parameters.push({ ParameterKey: 'ServiceName', ParameterValue: serviceName });
      return resolve(params);
    });
  });
}

