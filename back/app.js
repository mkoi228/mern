'use strict';
const throng = require('throng');

if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging') {
  require('dotenv').config();
}

Error.stackTraceLimit = 50;

const WORKERS = process.env.WEB_CONCURRENCY || 2;

throng({
  'workers': WORKERS,
  'lifetime': Infinity,
  'start': start
});

function start(id) {
  const logger = require('./config/logger.js');
  const config = require('konphyg')(__dirname + '/config').all().main;

  if ((process.env.NODE_ENV === 'production') && (process.env.SV_HOSTNAME.indexOf(config.mernapp.admin_hostname) === -1)) {
    // Enables newrelic in order to monitor performance
    require('newrelic');
  }

  logger.info(`Starting worker: ${id}`);

  // Set the DEBUG environment variable to enable debug output of Swagger Middleware AND Swagger Parser
  // process.env.DEBUG = 'swagger:*';

  const _                = require('underscore');
  const bodyParser       = require('body-parser');
  const compression      = require('compression');
  const cookieParser     = require('cookie-parser');
  const express          = require('express');
  const expressSession   = require('express-session');
  const middleware       = require('swagger-express-middleware');
  const mongoose         = require('mongoose');
  const cors             = require('cors');
  
  // mongoose.set('debug', true);
  const path             = require('path');
  const utils            = require('./config/utils');
  const NodeCache = require('node-cache');
  const mernapp_cache = new NodeCache();
  const dbURI = process.env.DB_URI ||
    process.env.MONGOHQ_URL ||
    process.env.MONGOLAB_URI ||
    'mongodb://localhost:27017/mernapp';

  const connectWithRetry = function() {
    logger.info('Attempting to connect to mongoose', dbURI);

    // mongoose.set('debug', true);
    return mongoose.connect(dbURI, { 'auto_reconnect': true, 'useNewUrlParser': true})
      .then(
        () => {
          logger.info('Connected to DB in', dbURI);

          require('./models/parent');
          require('./models/babysitter').babysitterSchema;

          // const modelsPath = __dirname + './models';
          // fs.readdirSync(modelsPath).forEach(function (file) {
          //   if (~file.indexOf('.js')) require(modelsPath + '/' + file)
          // });

          // Init express
          let app = express();

          app.use(cors());

          const { http } = require('./services/socketio')(app);

          app.use(compression());

          app.set('x-powered-by', '');
          app.disable('etag'); // disable etag to avoid caching

          // view engine setup
          app.set('views', path.join(__dirname, 'views'));
          app.set('view engine', 'jade');

          // parse application/x-www-form-urlencoded
          app.use(bodyParser.urlencoded({ 'extended': false }));

          // parse application/json
          app.use(bodyParser.json());

          // parse application/vnd.api+json as json
          app.use(bodyParser.json({ 'type': 'application/vnd.api+json' }));

          // parse cookies
          app.use(cookieParser());

          const MemoryStore = require('session-memory-store')(expressSession);

          app.use(expressSession({
            'name': 'JSESSION',
            'secret': 'kdl2mDzm29fRuda3f',
            'store': new MemoryStore()
          }));

          // swagger
          middleware(path.join(__dirname, 'mernapp.yaml'), app, function(err, middleware) {
          // helpers
            app.use(function(req, res, next) {
              app.locals.mernapp_cache = mernapp_cache;
              res.locals._ = _;
              res.locals.config = config;
              res.locals.sendSuccessResponse = utils.sendSuccessResponse;
              res.locals.sendErrorResponse = utils.sendErrorResponse;
              res.locals.environment = process.env.NODE_ENV;
              res.locals.inspect = require('util').inspect;
              next();
            });

            // static files folder
            app.use(express.static('public'));

            // Add all the Swagger Express Middleware, or just the ones you need.
            // NOTE: Some of these accept optional options (omitted here for brevity)
            app.use(
              middleware.metadata(),
              middleware.CORS(),
              middleware.files(),
              // middleware.parseRequest(null, { multipart: {dest: 'public/uploads/'} }),
              middleware.parseRequest(),
              middleware.validateRequest()
            );

            const preregistrations = require('./controllers/preregistrations.js');
            const admin            = require('./controllers/admin.js');
            // validation
            app.use(preregistrations.validateRequest);
            app.use(admin.validateTokenRequest);
            app.use(admin.validateRequest);

            app.locals.pretty = true;
            app.set('view options', { 'pretty': true });

            // set pretty to false for recommendations and index, otherwise the textearea text is
            // indented incorrectly (bug in Express? http://stackoverflow.com/questions/8232770/extra-whitespace-in-html-values-rendered-with-jade)
            app.use('/partials/:id', function(req, res, next) {
              if (req.params.id === 'babysitter_recommendations' || req.params.id === 'index') {
                app.set('view options', { 'pretty': false });
                app.locals.pretty = false;
                next();
              } else {
                app.set('view options', { 'pretty': true });
                app.locals.pretty = true;
                next();
              }
            });

            // routes
            const routes = require('./routes/index')(app);
            app.use('/', routes);

            // mock middleware
            app.use(middleware.mock());

            // Process Business related errors before HTTP Errors.
            const errors           = require('./routes/errors');
            errors.AppErrors(app);
            errors.RealBusinessErrors(app);
            errors.businessErrors(app);

            // Handle HTTP Errors.
            errors.httpErrors(app);

            // Uses heroku port or if missing config uses 3000
            const port = process.env.PORT || 3000;
            http.listen(port, () => {
              logger.info('mernapp is now running at port: ' + port);
              logger.info('mernapp: server booted up succesfully');
              logger.info('env:', app.get('env'));
              logger.info('pretty:', app.locals.pretty);

              const fs = require('fs');
              const path = require('path');
              const temp_dir = path.join(process.cwd(), 'temp/');

              if (!fs.existsSync(temp_dir)) {
                fs.mkdirSync(temp_dir);
              }
            });
          });
        },
        (err) => {
          logger.error('Failed to connect to mongo on startup - retrying in 5 sec', err);
          setTimeout(connectWithRetry, 5000);
        }
      );
  };

  connectWithRetry();
}