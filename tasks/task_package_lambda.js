'use strict';

var packageLambda = require('../utils/util_package_lambda');

module.exports = function (grunt) {

    // Please see the Grunt documentation for more information regarding task
    // creation: http://gruntjs.com/creating-tasks

    grunt.registerMultiTask('package_lambda', 'Creates a package to be uploaded to lambda', packageLambda.getHandler(grunt));

};