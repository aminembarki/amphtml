/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var fs = require('fs-extra');
var argv = require('minimist')(process.argv.slice(2));
var windowConfig = require('../window-config');
var closureCompiler = require('gulp-closure-compiler');
var gulp = require('gulp');
var rename = require('gulp-rename');
var replace = require('gulp-replace');
var internalRuntimeVersion = require('../internal-version').VERSION;
var internalRuntimeToken = require('../internal-version').TOKEN;
var rimraf = require('rimraf');

var isProdBuild = !!argv.type;
var queue = [];
var inProgress = 0;
var MAX_PARALLEL_CLOSURE_INVOCATIONS = 4;

// Compiles AMP with the closure compiler. This is intended only for
// production use. During development we intent to continue using
// babel, as it has much faster incremental compilation.
exports.closureCompile = function(entryModuleFilename, outputDir,
    outputFilename, options) {
  // Rate limit closure compilation to MAX_PARALLEL_CLOSURE_INVOCATIONS
  // concurrent processes.
  return new Promise(function(resolve) {
    function start() {
      inProgress++;
      compile(entryModuleFilename, outputDir, outputFilename, options)
          .then(function() {
            inProgress--;
            next();
            resolve();
          }, function(e) {
            console./*OK*/error('Compilation error', e.message);
            process.exit(1);
          });
    }
    function next() {
      if (!queue.length) {
        return;
      }
      if (inProgress < MAX_PARALLEL_CLOSURE_INVOCATIONS) {
        queue.shift()();
      }
    }
    queue.push(start);
    next();
  });
};

function cleanupBuildDir() {
  fs.mkdirsSync('build/cc');
  rimraf.sync('build/fake-module');
  rimraf.sync('build/patched-module');
  fs.mkdirsSync('build/patched-module/document-register-element/build');
  fs.mkdirsSync('build/fake-module/third_party/babel');
  fs.mkdirsSync('build/fake-module/src/polyfills/');
}
exports.cleanupBuildDir = cleanupBuildDir;

function compile(entryModuleFilename, outputDir,
    outputFilename, options) {
  return new Promise(function(resolve, reject) {
    const checkTypes = options.checkTypes || argv.typecheck_only;
    var intermediateFilename = 'build/cc/' +
        entryModuleFilename.replace(/\//g, '_').replace(/^\./, '');
    console./*OK*/log('Starting closure compiler for', entryModuleFilename);

    // If undefined/null or false then we're ok executing the deletions
    // and mkdir.
    if (!options.preventRemoveAndMakeDir) {
      cleanupBuildDir();
    }
    var unneededFiles = [
      'build/fake-module/third_party/babel/custom-babel-helpers.js',
    ];
    var wrapper = (options.includeWindowConfig ?
        windowConfig.getTemplate() : '') +
        '(function(){var process={env:{NODE_ENV:"production"}};' +
        '%output%})();';
    if (options.wrapper) {
      wrapper = options.wrapper.replace('<%= contents %>',
          // TODO(@cramforce): Switch to define.
          'var process={env:{NODE_ENV:"production"}};%output%');
    }
    wrapper += '\n//# sourceMappingURL=' +
        outputFilename + '.map\n';
    patchRegisterElement();
    if (fs.existsSync(intermediateFilename)) {
      fs.unlinkSync(intermediateFilename);
    }
    if (/development/.test(internalRuntimeToken)) {
      throw new Error('Should compile with a prod token');
    }
    var sourceMapBase = 'http://localhost:8000/';
    if (isProdBuild) {
      // Point sourcemap to fetch files from correct GitHub tag.
      sourceMapBase = 'https://raw.githubusercontent.com/ampproject/amphtml/' +
            internalRuntimeVersion + '/';
    }
    const srcs = [
      '3p/**/*.js',
      'ads/**/*.js',
      'extensions/**/*.js',
      'build/**/*.js',
      '!build/cc/**',
      '!build/polyfills.js',
      '!build/polyfills/**/*.js',
      'src/**/*.js',
      '!third_party/babel/custom-babel-helpers.js',
      // Exclude since it's not part of the runtime/extension binaries.
      '!extensions/amp-access/0.1/amp-login-done.js',
      'builtins/**.js',
      'third_party/caja/html-sanitizer.js',
      'third_party/closure-library/sha384-generated.js',
      'third_party/mustache/**/*.js',
      'node_modules/promise-pjs/promise.js',
      'build/patched-module/document-register-element/build/' +
          'document-register-element.max.js',
      'node_modules/core-js/modules/**.js',
      // Not sure what these files are, but they seem to duplicate code
      // one level below and confuse the compiler.
      '!node_modules/core-js/modules/library/**.js',
      // Don't include tests.
      '!**_test.js',
      '!**/test-*.js',
      '!**/*.extern.js',
    ];
    // Many files include the polyfills, but we only want to deliver them
    // once. Since all files automatically wait for the main binary to load
    // this works fine.
    if (options.includePolyfills) {
      srcs.push(
        '!build/fake-module/src/polyfills.js',
        '!build/fake-module/src/polyfills/**/*.js'
      );
    } else {
      srcs.push(
        '!src/polyfills.js',
        '!src/polyfills/**/*.js'
      );
      unneededFiles.push(
          'build/fake-module/src/polyfills.js',
          'build/fake-module/src/polyfills/promise.js',
          'build/fake-module/src/polyfills/math-sign.js');
    }
    unneededFiles.forEach(function(fake) {
      if (!fs.existsSync(fake)) {
        fs.writeFileSync(fake,
            '// Not needed in closure compiler\n' +
            'export function deadCode() {}');
      }
    });

    var externs = [
      'build-system/amp.extern.js',
      'third_party/closure-compiler/externs/intersection_observer.js',
    ];
    if (options.externs) {
      externs = externs.concat(options.externs);
    }

    /*eslint "google-camelcase/google-camelcase": 0*/
    var compilerOptions = {
      // Temporary shipping with our own compiler that has a single patch
      // applied
      compilerPath: 'build-system/runner/dist/runner.jar',
      fileName: intermediateFilename,
      continueWithWarnings: true,
      tieredCompilation: true,  // Magic speed up.
      compilerFlags: {
        compilation_level: 'SIMPLE_OPTIMIZATIONS',
        // Turns on more optimizations.
        assume_function_wrapper: true,
        // Transpile from ES6 to ES5.
        language_in: 'ECMASCRIPT6',
        language_out: 'ECMASCRIPT5',
        externs: externs,
        js_module_root: [
          'node_modules/',
          'build/patched-module/',
          'build/fake-module/',
        ],
        entry_point: entryModuleFilename,
        process_common_js_modules: true,
        // This strips all files from the input set that aren't explicitly
        // required.
        only_closure_dependencies: true,
        output_wrapper: wrapper,
        create_source_map: intermediateFilename + '.map',
        source_map_location_mapping:
            '|' + sourceMapBase,
        warning_level: 'DEFAULT',
        define: [],
        hide_warnings_for: [
          'node_modules/',
          'build/patched-module/',
          // TODO: The following three are whitelisted only because they're
          // blocking an unrelated PR.  But they appear to contain real type
          // errors and should be fixed at some point.
          'src/service.js',
          '3p/environment.js',
          'src/document-state.js'
        ],
      }
    };

    // For now do type check separately
    if (argv.typecheck_only || checkTypes) {
      // Don't modify compilation_level to a lower level since
      // it won't do strict type checking if its whitespace only.
      compilerOptions.compilerFlags.define.push('TYPECHECK_ONLY=true');
      compilerOptions.compilerFlags.jscomp_error = 'checkTypes';
    }
    if (argv.pseudo_names) {
      compilerOptions.compilerFlags.define.push('PSEUDO_NAMES=true');
    }
    if (argv.fortesting) {
      compilerOptions.compilerFlags.define.push('FORTESTING=true');
    }

    if (compilerOptions.compilerFlags.define.length == 0) {
      delete compilerOptions.compilerFlags.define;
    }

    var stream = gulp.src(srcs)
        .pipe(closureCompiler(compilerOptions))
        .on('error', function(err) {
          console./*OK*/error(err.message);
          process.exit(1);
        });

    // If we're only doing type checking, no need to output the files.
    if (!argv.typecheck_only) {
      stream = stream
        .pipe(rename(outputFilename))
        .pipe(replace(/\$internalRuntimeVersion\$/g, internalRuntimeVersion))
        .pipe(replace(/\$internalRuntimeToken\$/g, internalRuntimeToken))
        .pipe(gulp.dest(outputDir))
        .on('end', function() {
          console./*OK*/log('Compiled', entryModuleFilename, 'to',
              outputDir + '/' + outputFilename, 'via', intermediateFilename);
          gulp.src(intermediateFilename + '.map')
              .pipe(rename(outputFilename + '.map'))
              .pipe(gulp.dest(outputDir))
              .on('end', resolve);
        });
    }
    return stream;
  });
};

function patchRegisterElement() {
  // Copies document-register-element into a new file that has an export.
  // This works around a bug in closure compiler, where without the
  // export this module does not generate a goog.provide which fails
  // compilation.
  // Details https://github.com/google/closure-compiler/issues/1831
  const patchedName = 'build/patched-module/document-register-element' +
      '/build/document-register-element.max.js';
  if (!fs.existsSync(patchedName)) {
      fs.writeFileSync(patchedName,
          fs.readFileSync(
              'node_modules/document-register-element/build/' +
              'document-register-element.max.js') +
          '\n\nexport function deadCode() {}\n');
    }
}
