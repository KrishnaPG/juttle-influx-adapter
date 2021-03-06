'use strict';

var expect = require('chai').expect;
var _ = require('underscore');

var withAdapterAPI = require('juttle/test').utils.withAdapterAPI;

withAdapterAPI(() => {
    /* global JuttleAdapterAPI */
    var Rewriter = require('../../lib/ast/rewrite');
    var ASTVisitor = JuttleAdapterAPI.compiler.ASTVisitor;
    var utils = require('../test_utils');

    class StripMeta extends ASTVisitor {
        visit(node) {
            delete(node.location);
            delete(node.source);
            delete(node.d);
            this[`visit${node.type}`].apply(this, arguments);
            return node;
        }
    }

    var check_rewrite = function(from, to) {
        var strip = new StripMeta();
        var rewriter = new Rewriter();

        var from_ast = strip.visit(utils.parseFilter(from));
        var to_ast = strip.visit(utils.parseFilter(to));

        var new_ast = rewriter.rewrite(from_ast);
        expect(new_ast).to.deep.equal(to_ast, `${from} -> ${to}`);
    };

    describe('rewriter', () => {
        it('handles key1 in []', () => {
            var tests = [
                ['(key1 in [])', '0 = 1'],
                ['key1 in []', '0 = 1'],
                ['key1 in [] and key1 = "val1"', '0 = 1 and key1 = "val1"']
            ];
            _.each(tests, (test) => check_rewrite(test[0], test[1]));
        });

        it('rewrites in to or', () => {
            var tests = [
                ['key in [1, 5]', 'key = 1 or key = 5'],
                ['value in [1, 5]', 'value = 1 or value = 5'],
                ['key1 in ["val1"]', 'key1 = "val1"'],
                ['key1 in ["val1", "val2"]', 'key1 = "val1" or key1 = "val2"'],
                ['key1 in ["val1", "val2", "val3"]','key1 = "val1" or key1 = "val2" or key1 = "val3"'],
                ['key1 in ["val1", "val2", "val3", "val4"]','key1 = "val1" or key1 = "val2" or key1 = "val3" or key1 = "val4"'],
                ['key1 in ["val1", "val2"] and key2 in ["val3", "val4"]','( key1 = "val1" or key1 = "val2") and (key2 = "val3" or key2 = "val4")'],
            ];

            _.each(tests, (test) => check_rewrite(test[0], test[1]));
        });

        it('propagates negation into expressions', () => {
            var tests = [
                // Binary negations
                ['not (key1 = "val1")', 'key1 != "val1"'],
                ['not (key1 > "val1")', 'key1 <= "val1"'],
                ['not (key1 =~ "val1")', 'key1 !~ "val1"'],
                ['not (key1 !~ "val1")', 'key1 =~ "val1"'],

                // De morgan
                ['not (key1 = "val1" and key1 = "val2")', '(key1 != "val1" or key1 != "val2")'],
                ['not ( key1 < "val1" or key1 > "val1" )', '(key1 >= "val1" and key1 <= "val1")'],
                ['not (key1 = "val1" or key1 = "val2")', '(key1 != "val1" and key1 != "val2")'],
                ['not (key1 = "val1" or key1 = "val2" or key1 = "val3")', '(key1 != "val1" and key1 != "val2" and key1 != "val3")'],

                // Nested propagation
                ['not (key1 = "val1" and (key1 = "val2" or key1 = "val3"))', 'key1 != "val1" or (key1 != "val2" and key1 != "val3")'],

                // Double negation
                ['not ( not (key1 = "val1") )', 'key1 = "val1"'],
                ['not ( not (key1 > "val1") )', 'key1 > "val1"'],

                // Funky
                ['not ( ( not (key1 = "val1") ) and ( not ( key1 = "val2" ) ) )', '(key1 == "val1") or (key1 == "val2")']
            ];

            _.each(tests, (test) => check_rewrite(test[0], test[1]));
        });

        it('handles not in', () => {
            var tests = [
                ['not (key1 in ["val1", "val2"])', 'key1 != "val1" and key1 != "val2"']
            ];

            _.each(tests, (test) => check_rewrite(test[0], test[1]));
        });
    });
});
