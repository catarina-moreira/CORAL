"""
Flask application factory.
"""

from flask import Flask
import os


def create_app():
    """Create and configure the Flask application."""
    app = Flask(__name__, 
                template_folder='templates',
                static_folder='../static',
                static_url_path='/static')
    
    # Ensure UTF-8 encoding for all responses
    app.config['JSON_AS_ASCII'] = False
    
    @app.after_request
    def add_charset(response):
        if response.content_type and response.content_type.startswith('text/html'):
            response.headers['Content-Type'] = 'text/html; charset=utf-8'
        return response
    
    # Register blueprints
    from app.routes.main import main_bp
    from app.routes.drive import drive_bp
    from app.routes.mask import mask_bp
    from app.routes.local import local_bp
    
    app.register_blueprint(main_bp)
    app.register_blueprint(drive_bp, url_prefix='/api/drive')
    app.register_blueprint(local_bp, url_prefix='/api/local')
    app.register_blueprint(mask_bp, url_prefix='/api')
    
    return app
