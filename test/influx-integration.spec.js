'use strict';

var _ = require('underscore');
var expect = require('chai').expect;
var url = require('url');
var path = require('path');

var Promise = require('bluebird');
var retry = require('bluebird-retry');

var juttle_test_utils = require('juttle/test').utils;
var check_juttle = juttle_test_utils.check_juttle;

var retry_options = {
    interval: 50,
    timeout: 2000
};

var influx_api_url = url.format({
    protocol: 'http',
    hostname: process.env.INFLUX_HOST || 'localhost',
    port: process.env.INFLUX_PORT || 8086,
    pathname: '/'
});

var DB = require('./test_utils').DB.init(influx_api_url);

juttle_test_utils.configureAdapter({
    influx: {
        path: path.resolve(__dirname, '..'),
        url: influx_api_url
    }
});


describe('@integration influxdb tests', () => {
    describe('read', () => {
        before((done) => {
            DB.drop().then(() => { return DB.create(); }).then(() => { return DB.insert(); }).finally(done);
        });

        after((done) => {
            DB.drop().finally(done);
        });

        it('reports error on nonexistent database', () => {
            return check_juttle({
                program: 'read influx -db "doesnt_exist" -raw "SELECT * FROM /.*/"'
            }).then((res) => {
                expect(res.errors[0]).to.include('database not found');
            });
        });

        it('-raw option', () => {
            return check_juttle({
                program: 'read influx -db "test" -raw "SELECT * FROM cpu" | view logger'
            }).then((res) => {
                expect(res.errors.length).to.equal(0);
                expect(res.sinks.logger.length).to.equal(10);
                expect(res.sinks.logger[0].value).to.equal(0);
            });
        });

        it('reports error on invalid option', () => {
            return check_juttle({
                program: 'read influx -db "test" -raw "SELECT * FROM cpu" -badOption true'
            }).catch((err) => {
                expect(err.message).to.include('unknown read-influx option badOption');
            });
        });

        it('reports error to before from', () => {
            return check_juttle({
                program: 'read influx -db "test" -from :0: -raw "SELECT * FROM cpu" -from :1d ago: -to :2d ago:'
            }).catch((err) => {
                expect(err.code).to.equal('TO-BEFORE-FROM-MOMENT-ERROR');
            });
        });

        it('reports error with -raw and -from', () => {
            return check_juttle({
                program: 'read influx -db "test" -from :0: -raw "SELECT * FROM cpu" | view logger'
            }).catch((err) => {
                expect(err.message).to.include('-raw option should not be combined with -from, -to, or -last');
            });
        });

        it('reports error with -raw and filter', () => {
            return check_juttle({
                program: 'read influx -db "test" -from :0: -raw "SELECT * FROM cpu" value = 1 | view logger'
            }).catch((err) => {
                expect(err.message).to.include('option raw can only be used with empty filter');
            });
        });

        it('reports error without -from, -to or -last', () => {
            return check_juttle({
                program: 'read influx -db "test" value = 1 | view logger'
            }).catch((err) => {
                expect(err.message).to.include('One of -from, -to, or -last must be specified to define a query time range');
            });
        });

        it('basic select', () => {
            return check_juttle({
                program: 'read influx -db "test" -from :0: name = "cpu" | view logger'
            }).then((res) => {
                expect(res.sinks.logger.length).to.equal(10);
                expect(res.sinks.logger[0].value).to.equal(0);
            });
        });

        it('select across names', () => {
            return check_juttle({
                program: 'read influx -db "test" -from :0: -nameField "name" name =~ /^(cpu|mem)$/ | view logger'
            }).then((res) => {
                expect(res.sinks.logger.length).to.equal(20);
                expect(res.sinks.logger[0].time).to.equal(res.sinks.logger[1].time);

                _.each(res.sinks.logger, (pt, i) => {
                    expect(pt.name === 'cpu' || pt.name === 'mem').to.equal(true);
                });
            });
        });

        it('fields', () => {
            return check_juttle({
                program: 'read influx -db "test" -from :0: -fields "value" name = "cpu" | head 1 | view logger'
            }).then((res) => {
                expect(_.keys(res.sinks.logger[0])).to.deep.equal(['time', 'value', 'name']);
                expect(res.sinks.logger[0].value).to.equal(0);
            });
        });

        it('fields reports error if values not included', () => {
            return check_juttle({
                program: 'read influx -db "test" -from :0: -fields "host" name = "cpu" | head 1 | view logger'
            }).then((res) => {
                expect(res.errors[0]).to.include('at least one field in select clause');
            });
        });

        it('from', () => {
            var from = new Date(DB._t0 + 2 * DB._dt);
            return check_juttle({
                program: `read influx -db "test" -from :${from.toISOString()}: name = "cpu" | view logger`
            }).then((res) => {
                expect(res.sinks.logger.length).to.equal(8);
            });
        });

        it('to', () => {
            var to = new Date(DB._t0 + 2 * DB._dt);
            return check_juttle({
                program: `read influx -db "test" -from :0: -to :${to.toISOString()}: name = "cpu" | view logger`
            }).then((res) => {
                expect(res.errors).deep.equal([]);
                expect(res.sinks.logger.length).to.equal(2);
            });
        });

        it('from and to', () => {
            var from = new Date(DB._t0 + 2 * DB._dt);
            var to = new Date(DB._t0 + 5 * DB._dt);
            return check_juttle({
                program: `read influx -db "test" -from :${from.toISOString()}: -to :${to.toISOString()}: name = "cpu" | view logger`
            }).then((res) => {
                expect(res.sinks.logger.length).to.equal(3);
            });
        });

        it('to before from throws', () => {
            var from = new Date(DB._t0 + 5 * DB._dt);
            var to = new Date(DB._t0 + 2 * DB._dt);
            return check_juttle({
                program: `read influx -db "test" -from :${from.toISOString()}: -to :${to.toISOString()}: name = "cpu" | view logger`
            }).catch((err) => {
                expect(err.code).to.include('TO-BEFORE-FROM-MOMENT-ERROR');
            });
        });

        describe('filters', () => {
            it('on tags', () => {
                return check_juttle({
                    program: 'read influx -db "test"  -from :0: host = "host1" name = "cpu" | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(1);
                    expect(res.sinks.logger[0].host).to.equal('host1');
                });
            });

            it('on values', () => {
                return check_juttle({
                    program: 'read influx -db "test"  -from :0: name = "cpu" value = 5 | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(1);
                    expect(res.sinks.logger[0].value).to.equal(5);
                });
            });

            it('inequality on values', () => {
                return check_juttle({
                    program: 'read influx -db "test"  -from :0: name = "cpu" value > 8 | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(1);
                    expect(res.sinks.logger[0].value).to.equal(9);
                });
            });

            it('compound on tags', () => {
                return check_juttle({
                    program: 'read influx -db "test"  -from :0: name = "cpu" and (host = "host9" or host = "host1") | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(2);
                    expect(res.sinks.logger[0].host).to.equal('host1');
                    expect(res.sinks.logger[1].host).to.equal('host9');
                });
            });

            it('compound on values', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "cpu" and (value = 1 or value = 5) | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(2);
                    expect(res.sinks.logger[0].value).to.equal(1);
                    expect(res.sinks.logger[1].value).to.equal(5);
                });
            });

            it('regexes on values return empty result set', () => {
                return check_juttle({
                    program: 'read influx -db "test"  -from :0: name = "cpu" value =~ /[0-4]/ | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(0);
                });
            });

            it('globs on values return empty result set', () => {
                return check_juttle({
                    program: 'read influx -db "test"  -from :0: name = "cpu" value =~ "[0-4]" | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(0);
                });
            });

            it('regex on tags', () => {
                return check_juttle({
                    program: 'read influx -db "test"  -from :0: name = "cpu" host =~ /host[0-4]/ | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(5);
                    expect(res.sinks.logger[0].host).to.equal('host0');
                    expect(res.sinks.logger[4].host).to.equal('host4');
                });
            });

            it('glob on tags', () => {
                return check_juttle({
                    program: 'read influx -db "test"  -from :0: name = "cpu" host =~ "*os*5" | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(1);
                    expect(res.sinks.logger[0].host).to.equal('host5');
                });
            });

            // Bug: https://github.com/influxdata/influxdb/issues/5152
            it.skip('compound on tags and values', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "cpu" and (value = 1 or host = "host5") | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(2);
                    expect(res.sinks.logger[0].value).to.equal(1);
                    expect(res.sinks.logger[1].host).to.equal('host5');
                });
            });

            // Bug: https://github.com/influxdata/influxdb/issues/5152
            it.skip('compound inequalities on tags and values', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "cpu" and (value < 1 or host > "host8") | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(2);
                    expect(res.sinks.logger[0].value).to.equal(0);
                    expect(res.sinks.logger[1].host).to.equal('host9');
                });
            });

            it('not operator', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "cpu" and ( not ( value < 5 or value > 5 ) ) | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(1);
                    expect(res.sinks.logger[0].value).to.equal(5);
                });
            });

            it('in operator', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "cpu" and value in [1, 5] | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(2);
                    expect(res.sinks.logger[0].value).to.equal(1);
                    expect(res.sinks.logger[1].value).to.equal(5);
                });
            });

            it('in operator on tags', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "cpu" and host in ["host1", "host5"] | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(2);
                    expect(res.sinks.logger[0].host).to.equal("host1");
                    expect(res.sinks.logger[1].host).to.equal("host5");
                });
            });

            it('not in', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "cpu" and (not ( value in [0, 1, 2, 3, 4] )) | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(5);
                    expect(res.sinks.logger[0].value).to.equal(5);
                });
            });

            it('not in on tags', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "cpu" and (not ( host in ["host0", "host1", "host2", "host3", "host4"] )) | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(5);
                    expect(res.sinks.logger[0].host).to.equal("host5");
                });
            });
        });

        describe('string values', () => {
            before((done) => {
                let payload = '';

                for (let i = 0; i < 10; i++) {
                    payload += `regex,host=host${i} value="string${i}" ${DB._t0 + i * DB._dt}\n`;
                }

                DB.insert(payload).finally(done);
            });

            it('equality', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "regex" value = "string1" | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(1);
                    expect(res.sinks.logger[0].value).to.equal('string1');
                });
            });

            it('glob search returns empty result set', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "regex" value =~ "string[0-4]" | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(0);
                });
            });

            it('regex search returns empty result set', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "regex" value =~ /string[0-4]/ | view logger'
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(0);
                });
            });
        });

        describe('live', () => {
            before((done) => {
                let now = Date.now();
                let payload = '';

                for (let i = 0; i < 10; i++) {
                    payload += `live,host=host${i} value=${i} ${now + 500 + i * 50}\n`;
                }

                DB.insert(payload).finally(done);
            });

            it('successfully retrieves live points', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :now: -to :end: -every :0.1s: name = "live" | view logger',
                    realtime: true,
                    deactivateAfter: 1200
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(10);
                    expect(res.sinks.logger[9].value).to.equal(9);
                });
            });
        });

        describe('lag', () => {
            it('successfully retrieves lagging points', () => {
                // Start inserting points every 0.1s with 0.5s timestamp lag
                let i = 0;
                let insert = setInterval(() => {
                    if (i === 10) {
                        clearInterval(insert);
                        return;
                    }

                    let now = Date.now();
                    let payload = `lag,host=host${i} value=${i} ${now - 500}\n`;

                    DB.insert(payload);

                    i++;
                }, 100);

                return check_juttle({
                    program: 'read influx -db "test" -from :1s ago: -to :end: -every :0.1s: -lag :0.75s: name = "lag" | view logger',
                    realtime: true,
                    deactivateAfter: 1700
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(10);
                    expect(res.sinks.logger[9].value).to.equal(9);
                });
            });

            it('successfully retrieves current points', () => {
                // Start inserting points every 0.1s without lag
                let i = 0;
                let insert = setInterval(() => {
                    if (i === 10) {
                        clearInterval(insert);
                        return;
                    }

                    let now = Date.now();
                    let payload = `lagnow,host=host${i} value=${i} ${now}\n`;

                    DB.insert(payload);

                    i++;
                }, 100);

                return check_juttle({
                    program: 'read influx -db "test" -from :1s ago: -to :end: -every :0.1s: -lag :0.5s: name = "lagnow" | view logger',
                    realtime: true,
                    deactivateAfter: 1700
                }).then((res) => {
                    expect(res.sinks.logger.length).to.equal(10);
                    expect(res.sinks.logger[9].value).to.equal(9);
                });
            });
        });

        describe('nameField', () => {
            before((done) => {
                var payload = `namefield,host=hostX,name=conflict value=1 ${DB._t0}`;
                DB.insert(payload).finally(done);
            });

            it('overwrites the name by default and triggers a warning', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: name = "namefield" | head 1 | view logger'
                }).then((res) => {
                    expect(res.warnings).to.deep.equal(['internal error Points contain name field, use nameField option to make the field accessible.']);
                    expect(res.sinks.logger[0].name).to.equal('namefield');
                });
            });

            it('selects metric and stores its name based on nameField', () => {
                return check_juttle({
                    program: 'read influx -db "test" -from :0: -nameField "metric" metric = "namefield" | head 1 | view logger'
                }).then((res) => {
                    expect(res.sinks.logger[0].name).to.equal('conflict');
                    expect(res.sinks.logger[0].metric).to.equal('namefield');
                });
            });
        });

        describe('optimizations', () => {
            describe('head', () => {
                it('head n', () => {
                    return check_juttle({
                        program: 'read influx -db "test" -from :0: name = "cpu" | head 3 | view logger'
                    }).then((res) => {
                        expect(res.sinks.logger.length).to.equal(3);
                    });
                });

                it('head n, unoptimized', () => {
                    return check_juttle({
                        program: 'read influx -optimize false -db "test" -from :0: name = "cpu" | head 3 | view logger'
                    }).then((res) => {
                        expect(res.sinks.logger.length).to.equal(3);
                    });
                });
            });

            describe('tail', () => {
                it('tail n', () => {
                    return check_juttle({
                        program: 'read influx -db "test" -from :0: name = "cpu" | tail 3 | view logger'
                    }).then((res) => {
                        expect(res.sinks.logger.length).to.equal(3);
                        expect(res.sinks.logger[0].value).to.equal(7);
                        expect(res.sinks.logger[2].value).to.equal(9);
                    });
                });

                it('tail n, unoptimized', () => {
                    return check_juttle({
                        program: 'read influx -optimize false -db "test" -from :0: name = "cpu" | tail 3 | view logger'
                    }).then((res) => {
                        expect(res.sinks.logger.length).to.equal(3);
                        expect(res.sinks.logger[0].value).to.equal(7);
                        expect(res.sinks.logger[2].value).to.equal(9);
                    });
                });
            });
        });

    });

    describe('write', () => {
        beforeEach((done) => {
            DB.drop().then(() => { return DB.create(); }).finally(done);
        });

        afterEach((done) => {
            DB.drop().finally(done);
        });

        it('reports error on write to nonexistent db', () => {
            return check_juttle({
                program: 'emit -points [{"host":"host0","value":0,"name":"cpu"}] | write influx -db "doesnt_exist"'
            }).then((res) => {
                expect(res.errors[0]).to.include('database not found');
            });
        });

        it('reports warning without name', () => {
            return check_juttle({
                program: 'emit -points [{"host":"host0","value":0}] | write influx -db "test"'
            }).then((res) => {
                expect(res.warnings[0]).to.include('point is missing a name');
            });
        });

        it('point', () => {
            return check_juttle({
                program: 'emit -points [{"host":"host0","value":0,"name":"cpu"}] | write influx -db "test"'
            }).then((res) => {
                return retry(() => {
                    return DB.query('SELECT * FROM cpu WHERE value = 0').then((json) => {
                        var data = json.results[0].series[0];
                        expect(data.values[0][1]).to.equal("host0");
                        expect(data.values[0][2]).to.equal(0);
                    });
                }, retry_options);
            });
        });

        it('point with time', () => {
            var t = new Date(Date.now());
            return check_juttle({
                program: `emit -points [{"time":"${t.toISOString()}","host":"host0","value":0,"name":"cpu"}] | write influx -db "test"`
            }).then((res) => {
                return retry(() => {
                    return DB.query('SELECT * FROM cpu WHERE value = 0').then((json) => {
                        var data = json.results[0].series[0];
                        expect(new Date(data.values[0][0]).toISOString()).to.equal(t.toISOString());
                        expect(data.values[0][1]).to.equal("host0");
                        expect(data.values[0][2]).to.equal(0);
                    });
                }, retry_options);
            });
        });

        it('point with array triggers a warning', () => {
            return check_juttle({
                program: 'emit -limit 1 | put host = "host0", value = [1,2,3], name = "cpu" | write influx -db "test"'
            }).then((res) => {
                expect(res.warnings.length).to.not.equal(0);
                expect(res.warnings[0]).to.include('not supported');
            });
        });

        it('point with object triggers a warning', () => {
            return check_juttle({
                program: 'emit -limit 1 | put host = "host0", value = {k:"v"}, name = "cpu" | write influx -db "test"'
            }).then((res) => {
                expect(res.warnings.length).to.not.equal(0);
                expect(res.warnings[0]).to.include('not supported');
            });
        });

        it('valFields override', () => {
            return check_juttle({
                program: 'emit -points [{"host":"host0","value":0,"str":"value","name":"cpu"}] | write influx -db "test" -valFields "str"'
            }).then((res) => {
                return retry(() => {
                    return DB.query('SHOW FIELD KEYS').then((json) => {
                        var fields = _.flatten(json.results[0].series[0].values);
                        expect(fields).to.include('str');
                    });
                }, retry_options);
            });
        });

        it('intFields override', () => {
            return check_juttle({
                program: 'emit -points [{"host":"host0","value":0,"int_value":1,"name":"cpu"}] | write influx -db "test" -intFields "int_value"'
            }).then((res) => {
                return retry(() => {
                    return DB.query('SELECT * FROM cpu WHERE int_value = 1').then((json) => {
                        var data = json.results[0].series[0];
                        expect(data.values[0][1]).to.equal("host0");
                        expect(data.values[0][2]).to.equal(1);
                        expect(data.values[0][3]).to.equal(0);
                    });
                }, retry_options);
            });
        });

        it('can use name from the point', () => {
            return check_juttle({
                program: 'emit -points [{"m":"cpu","host":"host0","value":0}] | write influx -db "test" -nameField "m"'
            }).then((res) => {
                return retry(() => {
                    return DB.query('SELECT * FROM cpu WHERE value = 0').then((json) => {
                        var data = json.results[0].series[0];
                        expect(data.values[0][1]).to.equal("host0");
                        expect(data.values[0][2]).to.equal(0);
                    });
                }, retry_options);
            });
        });

        it('by default uses name field for name from the point', () => {
            return check_juttle({
                program: 'emit -points [{"name":"cpu","host":"host0","value":0}] | write influx -db "test"'
            }).then((res) => {
                return retry(() => {
                    return DB.query('SELECT * FROM cpu WHERE value = 0').then((json) => {
                        var data = json.results[0].series[0];
                        expect(data.values[0][1]).to.equal("host0");
                        expect(data.values[0][2]).to.equal(0);
                    });
                }, retry_options);
            });
        });

        it('two points', () => {
            // This is a workaround for emit adding same time in ms to both points
            // and influx treating time as primary index, overwriting the points
            return check_juttle({
                program: 'emit -points [{"host":"host0","value":0,"time"::now:},{"host":"host1","value":1,"time"::1s ago:}] | put name = "cpu" | write influx -db "test"'
            }).then((res) => {
                return retry(() => {
                    return DB.query('SELECT * FROM cpu').then((json) => {
                        var data = json.results[0].series[0];
                        expect(data.values.length).to.equal(2);
                    });
                }, retry_options);
            });
        });

        it('emits a warning on serialization but continues', () => {
            return check_juttle({
                program: 'emit -points [{"host":"host0","value":0,"time"::0:},{"n":"cpu","host":"host1","value":1,"time"::1:}] | write influx -db "test" -nameField "n"'
            }).then((res) => {
                expect(res.warnings.length).to.equal(1);
                expect(res.warnings[0]).to.include('point is missing a name');
                return retry(() => {
                    return DB.query('SELECT * FROM cpu WHERE value = 1').then((json) => {
                        var data = json.results[0].series[0];
                        expect(data.values[0][1]).to.equal("host1");
                        expect(data.values[0][2]).to.equal(1);
                    });
                }, retry_options);
            });
        });
    });
});
