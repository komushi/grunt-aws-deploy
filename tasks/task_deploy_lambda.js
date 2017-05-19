'use strict';

var deployLambda = require('../utils/util_deploy_lambda');

module.exports = function (grunt) {

    // Please see the Grunt documentation for more information regarding task
    // creation: http://gruntjs.com/creating-tasks

    grunt.registerMultiTask('deploy_lambda', 'Uploads a package to lambda', deployLambda.getHandler(grunt));
};
