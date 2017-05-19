'use strict';

const ServiceProvisioner = require('../utils/util_service_provisioner');

module.exports = function (grunt) {
  grunt.registerMultiTask('setup-api-gw-stack', 'Setup AWS resources and import swagger spec to make an API GW based service fully functional',
        function () {
          grunt.verbose.writeln(`Task : ${this.name}, Target : ${this.target}`);
          const done = this.async();

          const debugMode = grunt.option('verbose');

          const region = this.data.region;
          if (!region) {
            grunt.log.error('AWS region is required.');
            done(false);
            return;
          }

          const serviceName = this.data.serviceName;
          if (!serviceName) {
            grunt.log.error('Service Name is required.');
            done(false);
            return;
          }

          const deployStage = this.data.deployStage;
          if (!deployStage) {
            grunt.log.error('DeployStage is required.');
            done(false);
            return;
          }

          const config = this.data.config;
          if (!config) {
            grunt.log.error('Config is required.');
            done(false);
            return;
          }

          const cfnTemplateFile = this.data.cfnTemplateFile;
          if (!cfnTemplateFile) {
            grunt.log.error('cfn template file is required.');
            done(false);
            return;
          }

          if (!grunt.file.isFile(cfnTemplateFile)) {
            grunt.log.error('Could not find cfn templateFile.');
            done(false);
            return;
          }

          const swaggerFile = this.data.swaggerFile;
          if (!swaggerFile) {
            grunt.log.error('swagger file is required.');
            done(false);
            return;
          }

          if (!grunt.file.isFile(swaggerFile)) {
            grunt.log.error('Could not find swagger file.');
            done(false);
            return;
          }

          grunt.verbose.writeln(`Aws Region : ${region}, deployStage : ${deployStage}, svcName : ${serviceName}`);
          grunt.verbose.writeln(`CfnTemplate : ${cfnTemplateFile}, swaggerFile : ${swaggerFile}`);
          grunt.verbose.writeln(`config : ${JSON.stringify(config)}`);

          new ServiceProvisioner(region, deployStage, serviceName, debugMode)
                .setupApiGwService(cfnTemplateFile, config, swaggerFile)
                .then((results) => {
                  if (results.id) {
                    grunt.config.set(`${this.name}.${this.target}.APIID`, results.APIID);
                    grunt.log.writeln('APIID', results.APIID);
                    grunt.log.writeln('setup-api-gw-service results', results);
                    done();
                  } else {
                    grunt.log.error('APIID not found');
                    done(false);
                  }
                })
                .catch((err) => {
                  grunt.log.error('setup-api-gw-service failed due to ', err);
                  done(false);
                });
        }
    );

  grunt.registerMultiTask('create-or-update-stack', 'Setup AWS resources associated with a service',
        function () {
          grunt.verbose.writeln(`Task : ${this.name}, Target : ${this.target}`);
          const done = this.async();
          const debugMode = grunt.option('verbose');

          const region = this.data.region;
          if (!region) {
            grunt.log.error('AWS region is required.');
            done(false);
            return;
          }

          const serviceName = this.data.serviceName;
          if (!serviceName) {
            grunt.log.error('Service Name is required.');
            done(false);
            return;
          }

          const deployStage = this.data.deployStage;
          if (!deployStage) {
            grunt.log.error('deployStage is required.');
            done(false);
            return;
          }

          const config = this.data.config;
          if (!config) {
            grunt.log.error('Config is required.');
            done(false);
            return;
          }

          const cfnTemplateFile = this.data.cfnTemplateFile;
          if (!cfnTemplateFile) {
            grunt.log.error('cfn template file is required.');
            done(false);
            return;
          }

          if (!grunt.file.isFile(cfnTemplateFile)) {
            grunt.log.error('Could not find cfn templateFile.');
            done(false);
            return;
          }

          grunt.verbose.writeln(`Aws Region : ${region}, deployStage : ${deployStage}, svcName : ${serviceName}`);
          grunt.verbose.writeln(`CfnTemplate : ${cfnTemplateFile}`);
          grunt.verbose.writeln(`config : ${JSON.stringify(config)}`);
          new ServiceProvisioner(region, deployStage, serviceName, debugMode)
                .createOrUpdateStack(cfnTemplateFile, config)
                .then((cfnOutput) => {
                  grunt.config.set(`${this.name}.${this.target}.output`, cfnOutput);
                  grunt.log.writeln('cfn-create-or-update-stack results', cfnOutput);
                  done();
                  grunt.log.writeln('cfn-create-or-update-stack results', cfnOutput);
                  done();
                }
                )
                .catch((err) => {
                  grunt.log.error('cfn-create-or-update-stack failed due to ', err);
                  done(false);
                });
        }
    );

  grunt.registerMultiTask('swagger-import', 'Import swagger spec into API',
        function () {
          grunt.verbose.writeln(`Task : ${this.name}, Target : ${this.target}`);
          const done = this.async();
          const debugMode = grunt.option('verbose');

          const region = this.data.region;
          if (!region) {
            grunt.log.error('AWS region is required.');
            done(false);
            return;
          }

          const options = this.options({
            region,
            configVariable: this.nameArgs
          });
          const APIID = this.data.APIID;
          if (!APIID) {
            grunt.log.error('API ID is required.');
            done(false);
            return;
          }

          const swaggerFile = this.data.swaggerFile;
          if (!swaggerFile) {
            grunt.log.error('swagger file is required.');
            done(false);
            return;
          }

          if (!grunt.file.isFile(swaggerFile)) {
            grunt.log.error('Could not find swagger file.');
            done(false);
            return;
          }


          ServiceProvisioner.bundleExternals(swaggerFile)
            .then((bundledObject) => {
              const templateResolvedSwagger = ServiceProvisioner
                    .getYamlWithTemplateResolution(bundledObject, options.resolutionVariables);
              if (debugMode) {
                grunt.verbose.writeln(`Swagger being imported ${templateResolvedSwagger}`);
              }
              return ServiceProvisioner.importRestApi(region, APIID, templateResolvedSwagger);
            })
             .then((results) => {
               if (results.id) {
                 grunt.config.set(`${this.name}.${this.target}.APIID`, results.id);
                 grunt.log.writeln('APIID', results.id);
                 grunt.log.writeln('setup-api-gw-service results ', results);
                 done();
               } else {
                 grunt.log.error('APIID not found');
                 done(false);
               }
             })
             .catch((err) => {
               grunt.log.error('import-swagger failed due to ', err);
               done(false);
             });
        }
    );

  grunt.registerMultiTask('delete-service', 'Delete AWS resources associated with service',
        function () {
          grunt.verbose.writeln(`Task : ${this.name}, Target : ${this.target}`);
          const done = this.async();
          const debugMode = grunt.option('verbose');

          const region = this.data.region;
          if (!region) {
            grunt.log.error('AWS region is required.');
            done(false);
            return;
          }

          const serviceName = this.data.serviceName;
          if (!serviceName) {
            grunt.log.error('Service Name is required.');
            done(false);
            return;
          }

          const deployStage = this.data.deployStage;
          if (!deployStage) {
            grunt.log.error('DeployStage is required.');
            done(false);
            return;
          }

          grunt.verbose.writeln(`Aws Region : ${region}, deployStage : ${deployStage}, svcName : ${serviceName}`);
          new ServiceProvisioner(region, deployStage, serviceName, debugMode).deleteStack()
                .then((deleteServiceOutput) => {
                  grunt.log.writeln('delete-service results ', deleteServiceOutput);
                  done();
                }
                )
                .catch((err) => {
                  grunt.log.error('delete-service failed due to ', err);
                  done(false);
                });
        }
    );
};

